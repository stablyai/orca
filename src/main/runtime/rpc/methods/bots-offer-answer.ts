// An owner's press on a card, told to the agent as a hidden card answer: it queues behind a running
// turn and draws as nothing, where a typed one could steer that turn under the owner's name.
import {
  BotOfferAnswerParams,
  GOOGLE_OFFER_CLOCK_SKEW_MS,
  GOOGLE_OFFER_REPLAY_WINDOW_MS,
  MAX_GOOGLE_OFFER_ACTIONS,
  googleOfferActionTime,
  withBotOfferAnswer,
  type BotOfferAnswer,
  type BotOfferSelection,
  type BotOfferTold
} from '../../../../shared/bots/bot-offer-answers'
import type { PendingBotOfferAnswer } from '../../../bots/bot-offer-answer-writes'
import { runKeyedSerializedOperation } from '../../../../shared/concurrency/keyed-serialized-operations'
import { runtimeBotChats } from '../../../bots/bot-chat-session'
import { botOfSession } from '../../../bots/bot-session-tabs'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod, InvalidArgumentError } from '../core'
import { ownerOnly } from './bots-caller-gates'

type CardAnswer = { selection: BotOfferSelection; googleActionId?: string }
type AnswerText = string | ((current?: BotOfferAnswer) => Promise<string | null>)

const queuesByRuntime = new WeakMap<OrcaRuntimeService, Map<string, Promise<void>>>()

function answerQueues(runtime: OrcaRuntimeService): Map<string, Promise<void>> {
  let queues = queuesByRuntime.get(runtime)
  if (!queues) {
    queues = new Map()
    queuesByRuntime.set(runtime, queues)
  }
  return queues
}

function recentGoogleActions(answer: BotOfferAnswer | undefined, cutoff: number): string[] {
  return answer?.googleActionIds?.filter((id) => googleOfferActionTime(id) >= cutoff) ?? []
}

function googleReplayCutoff(answer: BotOfferAnswer | undefined, now: number): number {
  return Math.max(answer?.googleReplayCutoff ?? 0, now - GOOGLE_OFFER_REPLAY_WINDOW_MS)
}

function googleActionReplay(
  actionId: string,
  answer: BotOfferAnswer | undefined,
  now: number
): boolean {
  const issuedAt = googleOfferActionTime(actionId)
  const cutoff = googleReplayCutoff(answer, now)
  if (issuedAt < cutoff) {
    throw new InvalidArgumentError('This Google card answer expired. Sign in again to continue.')
  }
  if (issuedAt > now + GOOGLE_OFFER_CLOCK_SKEW_MS) {
    throw new InvalidArgumentError("This Google card answer is ahead of the host's clock.")
  }
  const retained = recentGoogleActions(answer, cutoff)
  if (retained.includes(actionId)) {
    return true
  }
  // An unexpired receipt must never be discarded to make room for a new action.
  if (retained.length >= MAX_GOOGLE_OFFER_ACTIONS) {
    throw new InvalidArgumentError('This card has too many recent Google answers. Try again later.')
  }
  return false
}

async function saveCardAnswer(
  runtime: OrcaRuntimeService,
  { botId, selection, googleActionId }: PendingBotOfferAnswer
): Promise<BotOfferTold> {
  const { cardId } = selection
  const bot = await runtime.bots.update(botId, (current) => {
    const offerAnswers = withBotOfferAnswer(current.offerAnswers, selection)
    const answer = offerAnswers.at(-1)
    if (answer && googleActionId) {
      const cutoff = googleReplayCutoff(answer, Date.now())
      const retained = recentGoogleActions(answer, cutoff)
      if (googleOfferActionTime(googleActionId) >= cutoff && !retained.includes(googleActionId)) {
        retained.push(googleActionId)
      }
      answer.googleActionIds = retained
      answer.googleReplayCutoff = cutoff
    }
    return { offerAnswerConfirmation: { cardId, answers: offerAnswers } }
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
  const { pending } = runtime.bots.offerAnswerWrites
  return runKeyedSerializedOperation(answerQueues(runtime), key, async () => {
    // A failed profile write can be retried without sending the already admitted turn again.
    const unsaved = pending.get(key)
    if (unsaved) {
      await saveCardAnswer(runtime, unsaved)
      pending.delete(key)
    }

    const bot = runtime.bots.list().find((entry) => entry.id === botId)
    const current = bot?.offerAnswers?.find((entry) => entry.cardId === selection.cardId)
    if (googleActionId) {
      if (googleActionReplay(googleActionId, current, Date.now())) {
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
    if (!runtime.bots.list().some((entry) => entry.id === botId)) {
      throw new Error('bot_not_found')
    }
    const write = {
      botId,
      googleActionId,
      selection: told ? selection : { cardId: selection.cardId }
    }
    pending.set(key, write)
    const confirmed = await saveCardAnswer(runtime, write)
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
