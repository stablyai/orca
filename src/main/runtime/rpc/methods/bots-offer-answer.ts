// An owner's press on a card, told to the agent as a hidden card answer: it queues behind a running
// turn and draws as nothing, where a typed one could steer that turn under the owner's name.
import {
  BotOfferAnswerParams,
  withBotOfferAnswer,
  type BotOfferAnswer,
  type BotOfferSelection,
  type BotOfferTold
} from '../../../../shared/bots/bot-offer-answers'
import { runKeyedSerializedOperation } from '../../../../shared/concurrency/keyed-serialized-operations'
import { runtimeBotChats } from '../../../bots/bot-chat-session'
import { botOfSession } from '../../../bots/bot-session-tabs'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod, InvalidArgumentError } from '../core'
import { ownerOnly } from './bots-caller-gates'

type CardAnswer = { selection: BotOfferSelection; googleActionId?: string }
type PendingAnswer = { selection: BotOfferAnswer; googleActionId?: string }
type AnswerText = string | ((current?: BotOfferAnswer) => Promise<string | null>)
type AnswerWrites = {
  queues: Map<string, Promise<void>>
  pending: Map<string, PendingAnswer>
}

const writesByRuntime = new WeakMap<OrcaRuntimeService, AnswerWrites>()

function answerWrites(runtime: OrcaRuntimeService): AnswerWrites {
  const current = writesByRuntime.get(runtime)
  if (current) {
    return current
  }
  const writes = { queues: new Map(), pending: new Map() }
  writesByRuntime.set(runtime, writes)
  return writes
}

async function saveCardAnswer(
  runtime: OrcaRuntimeService,
  botId: string,
  { selection, googleActionId }: PendingAnswer
): Promise<BotOfferTold> {
  const { cardId } = selection
  const bot = await runtime.bots.update(botId, (current) => {
    const offerAnswers = withBotOfferAnswer(current.offerAnswers, selection)
    const answer = offerAnswers.at(-1)
    if (answer && googleActionId && !answer.googleActionIds?.includes(googleActionId)) {
      answer.googleActionIds = [...(answer.googleActionIds ?? []), googleActionId]
    }
    return { offerAnswers }
  })
  return { sent: true, answer: bot.offerAnswers?.find((entry) => entry.cardId === cardId) }
}

function confirmCardAnswer(
  runtime: OrcaRuntimeService,
  botId: string,
  card: CardAnswer,
  tell: (current?: BotOfferAnswer) => Promise<BotOfferTold | null>
): Promise<BotOfferTold> {
  const { selection, googleActionId } = card
  const key = JSON.stringify([botId, selection.cardId])
  const { queues, pending } = answerWrites(runtime)
  return runKeyedSerializedOperation(queues, key, async () => {
    // A failed profile write can be retried without sending the already admitted turn again.
    const unsaved = pending.get(key)
    if (unsaved) {
      await saveCardAnswer(runtime, botId, unsaved)
      pending.delete(key)
    }

    const bot = runtime.bots.list().find((entry) => entry.id === botId)
    const current = bot?.offerAnswers?.find((entry) => entry.cardId === selection.cardId)
    if (googleActionId) {
      if (current?.googleActionIds?.includes(googleActionId)) {
        return { sent: true, answer: current }
      }
    } else if (current?.sent || ('dismissed' in selection && current?.dismissed)) {
      return { sent: true, answer: current }
    }

    const sameGoogleAccount =
      googleActionId && 'sent' in selection && current?.sent?.chosen[0] === selection.sent.chosen[0]
    const told = sameGoogleAccount ? null : await tell(current)
    if (told && !told.sent) {
      return { sent: false }
    }
    const write = told ? card : { googleActionId, selection: { cardId: selection.cardId } }
    pending.set(key, write)
    const confirmed = await saveCardAnswer(runtime, botId, write)
    pending.delete(key)
    return confirmed
  })
}

/** Sends `line` as a card answer into `sessionId`, which must be one of the bot's chats, or into its Chat. */
export async function tellBotCardAnswer(
  runtime: OrcaRuntimeService,
  botId: string,
  sessionId: string | undefined,
  line: AnswerText,
  card?: CardAnswer
): Promise<BotOfferTold> {
  if (sessionId) {
    // The host may have restarted since the card drew; an absent one would read every chat as no bot's.
    await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
    if (botOfSession(runtime.bots, sessionId)?.id !== botId) {
      throw new InvalidArgumentError("That chat isn't one of this bot's.")
    }
  }
  const tell = async (current?: BotOfferAnswer): Promise<BotOfferTold | null> => {
    const text = typeof line === 'string' ? line : await line(current)
    if (text === null) {
      return null
    }
    const chats = runtimeBotChats(runtime)
    const { outcome } = sessionId
      ? await chats.sendToSession(botId, sessionId, text, undefined, 'card-answer')
      : await chats.sendToChat(botId, text, 'card-answer')
    return { sent: outcome.kind !== 'refused' }
  }
  return card ? confirmCardAnswer(runtime, botId, card, tell) : ((await tell()) ?? { sent: true })
}

export const BOT_OFFER_ANSWER_METHOD = defineMethod({
  name: 'bots.offer.answer',
  permission: 'workspace',
  params: BotOfferAnswerParams,
  handler: async ({ botId, sessionId, text, answer }, context) => {
    ownerOnly(context, 'Only your owner answers offer cards, in Orca.')
    context.runtime.bots.assertEnabled()
    return tellBotCardAnswer(
      context.runtime,
      botId,
      sessionId,
      text,
      answer && { selection: answer }
    )
  }
})
