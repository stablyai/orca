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
import { offerAnswerKey, type PendingBotOfferAnswer } from '../../../bots/bot-offer-answer-writes'
import { mintAgentSessionOperationId } from '../../orchestration/mailbox/structured-pointer/structured-pointer-operation-id'
import { runKeyedSerializedOperation } from '../../../../shared/concurrency/keyed-serialized-operations'
import { runtimeBotChats } from '../../../bots/bot-chat-session'
import { botOfSession } from '../../../bots/bot-session-tabs'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod, InvalidArgumentError } from '../core'
import { ownerOnly } from './bots-caller-gates'

type CardAnswer = { selection: BotOfferSelection; googleActionId?: string }
type AnswerText = string | ((current?: BotOfferAnswer) => Promise<string | null>)
/** Tells the bot under `operationId`; the same id again replays an admitted turn. */
type TellCard = (
  current: BotOfferAnswer | undefined,
  operationId: string
) => Promise<BotOfferTold | null>

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
  now: number,
  cutoff: number
): boolean {
  const issuedAt = googleOfferActionTime(actionId)
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

/** `told`: this request told the bot; a saved answer it didn't tell is reported as not sent. */
async function saveCardAnswer(
  runtime: OrcaRuntimeService,
  { botId, selection, googleAction }: PendingBotOfferAnswer,
  told = false
): Promise<BotOfferTold> {
  const { cardId } = selection
  const bot = await runtime.bots.update(botId, (current) => {
    const offerAnswers = withBotOfferAnswer(current.offerAnswers, selection)
    const answer = offerAnswers.at(-1)
    if (answer && googleAction) {
      // A clock rollback after chat admission must not revive receipts excluded by the capacity check.
      const cutoff = Math.max(googleAction.admissionCutoff, googleReplayCutoff(answer, Date.now()))
      const retained = recentGoogleActions(answer, cutoff)
      if (googleOfferActionTime(googleAction.id) >= cutoff && !retained.includes(googleAction.id)) {
        retained.push(googleAction.id)
      }
      answer.googleActionIds = retained
      answer.googleReplayCutoff = cutoff
    }
    return { offerAnswerConfirmation: { cardId, answers: offerAnswers } }
  })
  return { sent: told, answer: bot.offerAnswers?.find((entry) => entry.cardId === cardId) }
}

function confirmCardAnswer(
  runtime: OrcaRuntimeService,
  botId: string,
  card: CardAnswer,
  tell: TellCard
): Promise<BotOfferTold> {
  const { selection, googleActionId } = card
  const key = offerAnswerKey(botId, selection.cardId)
  const writes = runtime.bots.offerAnswerWrites
  const { pending, operations } = writes
  return runKeyedSerializedOperation(answerQueues(runtime), key, async () => {
    // A failed profile write can be retried without sending the already admitted turn again.
    const unsaved = pending.get(key)
    if (unsaved) {
      await saveCardAnswer(runtime, unsaved)
      pending.delete(key)
    }

    if (writes.claimInFlight(key)) {
      // An older client claimed the card and hasn't said whether the bot took it.
      throw new InvalidArgumentError('This card is still being answered. Try again in a moment.')
    }
    const bot = runtime.bots.list().find((entry) => entry.id === botId)
    const current = bot?.offerAnswers?.find((entry) => entry.cardId === selection.cardId)
    let googleAction: PendingBotOfferAnswer['googleAction']
    if (googleActionId) {
      const now = Date.now()
      const admissionCutoff = googleReplayCutoff(current, now)
      if (googleActionReplay(googleActionId, current, now, admissionCutoff)) {
        return { sent: false, answer: current }
      }
      googleAction = { id: googleActionId, admissionCutoff }
    } else if (current?.sent || ('dismissed' in selection && current?.dismissed)) {
      // Not proof the bot heard it: an older client's claim can stand without a send.
      return { sent: false, answer: current }
    }

    const sameGoogleAccount =
      googleActionId && 'sent' in selection && current?.sent?.chosen[0] === selection.sent.chosen[0]
    let told: BotOfferTold | null = null
    if (!sameGoogleAccount) {
      // Kept through a failed or lost send, so the retry replays the turn the host may have admitted.
      const operationId =
        operations.get(key)?.operationId ?? mintAgentSessionOperationId(Date.now())
      operations.set(key, { botId, operationId })
      told = await tell(current, operationId)
      if (!told?.sent) {
        operations.delete(key)
      }
    }
    if (told && !told.sent) {
      return { sent: false }
    }
    if (!runtime.bots.list().some((entry) => entry.id === botId)) {
      throw new Error('bot_not_found')
    }
    const write = {
      botId,
      googleAction,
      selection: told ? selection : { cardId: selection.cardId }
    }
    pending.set(key, write)
    operations.delete(key)
    const confirmed = await saveCardAnswer(runtime, write, told?.sent === true)
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
  const tell = async (
    current?: BotOfferAnswer,
    operationId?: string
  ): Promise<BotOfferTold | null> => {
    const text = typeof line === 'string' ? line : await line(current)
    if (text === null) {
      return null
    }
    const chats = runtimeBotChats(runtime)
    const run = operationId ? { messageId: operationId } : undefined
    const { outcome } = sessionId
      ? await chats.sendToSession(botId, sessionId, text, run, 'card-answer')
      : await chats.sendToChat(botId, text, 'card-answer', run)
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
