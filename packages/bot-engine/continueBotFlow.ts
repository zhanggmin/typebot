import {
  AnswerInSessionState,
  Block,
  BubbleBlockType,
  ChatReply,
  InputBlock,
  InputBlockType,
  IntegrationBlockType,
  LogicBlockType,
  SessionState,
  defaultPaymentInputOptions,
  invalidEmailDefaultRetryMessage,
} from '@typebot.io/schemas'
import { isInputBlock, byId } from '@typebot.io/lib'
import { executeGroup, parseInput } from './executeGroup'
import { getNextGroup } from './getNextGroup'
import { validateEmail } from './blocks/inputs/email/validateEmail'
import { formatPhoneNumber } from './blocks/inputs/phone/formatPhoneNumber'
import { validateUrl } from './blocks/inputs/url/validateUrl'
import { resumeChatCompletion } from './blocks/integrations/openai/resumeChatCompletion'
import { resumeWebhookExecution } from './blocks/integrations/webhook/resumeWebhookExecution'
import { upsertAnswer } from './queries/upsertAnswer'
import { parseButtonsReply } from './blocks/inputs/buttons/parseButtonsReply'
import { ParsedReply } from './types'
import { validateNumber } from './blocks/inputs/number/validateNumber'
import { parseDateReply } from './blocks/inputs/date/parseDateReply'
import { validateRatingReply } from './blocks/inputs/rating/validateRatingReply'
import { parsePictureChoicesReply } from './blocks/inputs/pictureChoice/parsePictureChoicesReply'
import { parseVariables } from './variables/parseVariables'
import { updateVariablesInSession } from './variables/updateVariablesInSession'
import { startBotFlow } from './startBotFlow'
import { TRPCError } from '@trpc/server'

type Params = {
  version: 1 | 2
  state: SessionState
}
export const continueBotFlow = async (
  reply: string | undefined,
  { state, version }: Params
): Promise<ChatReply & { newSessionState: SessionState }> => {
  let firstBubbleWasStreamed = false
  let newSessionState = { ...state }

  if (!newSessionState.currentBlock) return startBotFlow({ state, version })

  const group = state.typebotsQueue[0].typebot.groups.find(
    (group) => group.id === state.currentBlock?.groupId
  )
  const blockIndex =
    group?.blocks.findIndex(
      (block) => block.id === state.currentBlock?.blockId
    ) ?? -1

  const block = blockIndex >= 0 ? group?.blocks[blockIndex ?? 0] : null

  if (!block || !group)
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Group / block not found',
    })

  if (block.type === LogicBlockType.SET_VARIABLE) {
    const existingVariable = state.typebotsQueue[0].typebot.variables.find(
      byId(block.options.variableId)
    )
    if (existingVariable && reply) {
      const newVariable = {
        ...existingVariable,
        value: safeJsonParse(reply),
      }
      newSessionState = updateVariablesInSession(state)([newVariable])
    }
  } else if (reply && block.type === IntegrationBlockType.WEBHOOK) {
    const result = resumeWebhookExecution({
      state,
      block,
      response: JSON.parse(reply),
    })
    if (result.newSessionState) newSessionState = result.newSessionState
  } else if (
    block.type === IntegrationBlockType.OPEN_AI &&
    block.options.task === 'Create chat completion'
  ) {
    firstBubbleWasStreamed = true
    if (reply) {
      const result = await resumeChatCompletion(state, {
        options: block.options,
        outgoingEdgeId: block.outgoingEdgeId,
      })(reply)
      newSessionState = result.newSessionState
    }
  }

  let formattedReply: string | undefined

  if (isInputBlock(block)) {
    const parsedReplyResult = parseReply(newSessionState)(reply, block)

    if (parsedReplyResult.status === 'fail')
      return {
        ...(await parseRetryMessage(newSessionState)(block)),
        newSessionState,
      }

    formattedReply =
      'reply' in parsedReplyResult ? parsedReplyResult.reply : undefined
    const nextEdgeId = getOutgoingEdgeId(newSessionState)(block, formattedReply)
    const itemId = nextEdgeId
      ? newSessionState.typebotsQueue[0].typebot.edges.find(byId(nextEdgeId))
          ?.from.itemId
      : undefined
    newSessionState = await processAndSaveAnswer(
      state,
      block,
      itemId
    )(formattedReply)
  }

  const groupHasMoreBlocks = blockIndex < group.blocks.length - 1

  const nextEdgeId = getOutgoingEdgeId(newSessionState)(block, formattedReply)

  if (groupHasMoreBlocks && !nextEdgeId) {
    const chatReply = await executeGroup(
      {
        ...group,
        blocks: group.blocks.slice(blockIndex + 1),
      },
      { version, state: newSessionState, firstBubbleWasStreamed }
    )
    return {
      ...chatReply,
      lastMessageNewFormat:
        formattedReply !== reply ? formattedReply : undefined,
    }
  }

  if (!nextEdgeId && state.typebotsQueue.length === 1)
    return {
      messages: [],
      newSessionState,
      lastMessageNewFormat:
        formattedReply !== reply ? formattedReply : undefined,
    }

  const nextGroup = await getNextGroup(newSessionState)(nextEdgeId)

  newSessionState = nextGroup.newSessionState

  if (!nextGroup.group)
    return {
      messages: [],
      newSessionState,
      lastMessageNewFormat:
        formattedReply !== reply ? formattedReply : undefined,
    }

  const chatReply = await executeGroup(nextGroup.group, {
    version,
    state: newSessionState,
    firstBubbleWasStreamed,
  })

  return {
    ...chatReply,
    lastMessageNewFormat: formattedReply !== reply ? formattedReply : undefined,
  }
}

const processAndSaveAnswer =
  (state: SessionState, block: InputBlock, itemId?: string) =>
  async (reply: string | undefined): Promise<SessionState> => {
    if (!reply) return state
    let newState = await saveAnswer(state, block, itemId)(reply)
    newState = saveVariableValueIfAny(newState, block)(reply)
    return newState
  }

const saveVariableValueIfAny =
  (state: SessionState, block: InputBlock) =>
  (reply: string): SessionState => {
    if (!block.options.variableId) return state
    const foundVariable = state.typebotsQueue[0].typebot.variables.find(
      (variable) => variable.id === block.options.variableId
    )
    if (!foundVariable) return state

    const newSessionState = updateVariablesInSession(state)([
      {
        ...foundVariable,
        value: Array.isArray(foundVariable.value)
          ? foundVariable.value.concat(reply)
          : reply,
      },
    ])

    return newSessionState
  }

const parseRetryMessage =
  (state: SessionState) =>
  async (block: InputBlock): Promise<Pick<ChatReply, 'messages' | 'input'>> => {
    const retryMessage =
      'retryMessageContent' in block.options &&
      block.options.retryMessageContent
        ? block.options.retryMessageContent
        : parseDefaultRetryMessage(block)
    return {
      messages: [
        {
          id: block.id,
          type: BubbleBlockType.TEXT,
          content: {
            richText: [{ type: 'p', children: [{ text: retryMessage }] }],
          },
        },
      ],
      input: await parseInput(state)(block),
    }
  }

const parseDefaultRetryMessage = (block: InputBlock): string => {
  switch (block.type) {
    case InputBlockType.EMAIL:
      return invalidEmailDefaultRetryMessage
    case InputBlockType.PAYMENT:
      return defaultPaymentInputOptions.retryMessageContent as string
    default:
      return 'Invalid message. Please, try again.'
  }
}

const saveAnswer =
  (state: SessionState, block: InputBlock, itemId?: string) =>
  async (reply: string): Promise<SessionState> => {
    await upsertAnswer({
      block,
      answer: {
        blockId: block.id,
        itemId,
        groupId: block.groupId,
        content: reply,
        variableId: block.options.variableId,
      },
      reply,
      state,
      itemId,
    })

    const key = block.options.variableId
      ? state.typebotsQueue[0].typebot.variables.find(
          (variable) => variable.id === block.options.variableId
        )?.name
      : state.typebotsQueue[0].typebot.groups.find((group) =>
          group.blocks.find((blockInGroup) => blockInGroup.id === block.id)
        )?.title

    return setNewAnswerInState(state)({
      key: key ?? block.id,
      value: reply,
    })
  }

const setNewAnswerInState =
  (state: SessionState) => (newAnswer: AnswerInSessionState) => {
    const answers = state.typebotsQueue[0].answers
    const newAnswers = answers
      .filter((answer) => answer.key !== newAnswer.key)
      .concat(newAnswer)

    return {
      ...state,
      typebotsQueue: state.typebotsQueue.map((typebot, index) =>
        index === 0
          ? {
              ...typebot,
              answers: newAnswers,
            }
          : typebot
      ),
    } satisfies SessionState
  }

const getOutgoingEdgeId =
  (state: Pick<SessionState, 'typebotsQueue'>) =>
  (block: Block, reply: string | undefined) => {
    const variables = state.typebotsQueue[0].typebot.variables
    if (
      block.type === InputBlockType.CHOICE &&
      !block.options.isMultipleChoice &&
      reply
    ) {
      const matchedItem = block.items.find(
        (item) =>
          parseVariables(variables)(item.content).normalize() ===
          reply.normalize()
      )
      if (matchedItem?.outgoingEdgeId) return matchedItem.outgoingEdgeId
    }
    if (
      block.type === InputBlockType.PICTURE_CHOICE &&
      !block.options.isMultipleChoice &&
      reply
    ) {
      const matchedItem = block.items.find(
        (item) =>
          parseVariables(variables)(item.title).normalize() ===
          reply.normalize()
      )
      if (matchedItem?.outgoingEdgeId) return matchedItem.outgoingEdgeId
    }
    return block.outgoingEdgeId
  }

const parseReply =
  (state: SessionState) =>
  (inputValue: string | undefined, block: InputBlock): ParsedReply => {
    switch (block.type) {
      case InputBlockType.EMAIL: {
        if (!inputValue) return { status: 'fail' }
        const isValid = validateEmail(inputValue)
        if (!isValid) return { status: 'fail' }
        return { status: 'success', reply: inputValue }
      }
      case InputBlockType.PHONE: {
        if (!inputValue) return { status: 'fail' }
        const formattedPhone = formatPhoneNumber(
          inputValue,
          block.options.defaultCountryCode
        )
        if (!formattedPhone) return { status: 'fail' }
        return { status: 'success', reply: formattedPhone }
      }
      case InputBlockType.URL: {
        if (!inputValue) return { status: 'fail' }
        const isValid = validateUrl(inputValue)
        if (!isValid) return { status: 'fail' }
        return { status: 'success', reply: inputValue }
      }
      case InputBlockType.CHOICE: {
        if (!inputValue) return { status: 'fail' }
        return parseButtonsReply(state)(inputValue, block)
      }
      case InputBlockType.NUMBER: {
        if (!inputValue) return { status: 'fail' }
        const isValid = validateNumber(inputValue)
        if (!isValid) return { status: 'fail' }
        return { status: 'success', reply: inputValue }
      }
      case InputBlockType.DATE: {
        if (!inputValue) return { status: 'fail' }
        return parseDateReply(inputValue, block)
      }
      case InputBlockType.FILE: {
        if (!inputValue)
          return block.options.isRequired
            ? { status: 'fail' }
            : { status: 'skip' }
        return { status: 'success', reply: inputValue }
      }
      case InputBlockType.PAYMENT: {
        if (!inputValue) return { status: 'fail' }
        if (inputValue === 'fail') return { status: 'fail' }
        return { status: 'success', reply: inputValue }
      }
      case InputBlockType.RATING: {
        if (!inputValue) return { status: 'fail' }
        const isValid = validateRatingReply(inputValue, block)
        if (!isValid) return { status: 'fail' }
        return { status: 'success', reply: inputValue }
      }
      case InputBlockType.PICTURE_CHOICE: {
        if (!inputValue) return { status: 'fail' }
        return parsePictureChoicesReply(state)(inputValue, block)
      }
      case InputBlockType.TEXT: {
        if (!inputValue) return { status: 'fail' }
        return { status: 'success', reply: inputValue }
      }
    }
  }

export const safeJsonParse = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
