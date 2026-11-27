// An owner's press on a card, told to the agent as a hidden card answer: it queues behind a running
// turn and draws as nothing, where a typed one could steer that turn under the owner's name.
import { BotOfferAnswerParams, type BotOfferTold } from '../../../../shared/bots/bot-offer-answers'
import { runtimeBotChats } from '../../../bots/bot-chat-session'
import { botOfSession } from '../../../bots/bot-session-tabs'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod, InvalidArgumentError } from '../core'
import { ownerOnly } from './bots-caller-gates'

// Card answers each host told (or is telling), by bot and answer key, with what each chose. Keyed without
// the chat: a card sits in one, and its answer is the same whichever way a client names it. Enough for
// the presses one lost reply can repeat; a host restart forgets them.
const MAX_TOLD_CARD_ANSWERS = 256
const toldCardAnswers = new WeakMap<OrcaRuntimeService, Map<string, Promise<BotOfferTold>>>()

/** One card answer's idempotency key, and what it chose. */
export type CardAnswerKey = { answerKey: string; chosen?: readonly string[] }

/** Sends `line` as a card answer into `sessionId`, which must be one of the bot's chats, or into its Chat.
 *  With `key`, a repeat of an answer this host told (a press again after a lost reply, another window,
 *  a reload) tells the bot nothing new and returns what it was told, so the card can show that; a refused
 *  or failed one is forgotten so it can go again. Nothing throws once the chat admitted a send. */
export function tellBotCardAnswer(
  runtime: OrcaRuntimeService,
  botId: string,
  sessionId: string | undefined,
  line: string,
  key?: CardAnswerKey
): Promise<BotOfferTold> {
  if (!key) {
    return tellOnce(runtime, botId, sessionId, line)
  }
  let told = toldCardAnswers.get(runtime)
  if (!told) {
    told = new Map()
    toldCardAnswers.set(runtime, told)
  }
  const slot = JSON.stringify([botId, key.answerKey])
  const prior = told.get(slot)
  if (prior) {
    return prior
  }
  const chosen = key.chosen ? [...key.chosen] : undefined
  const telling = tellOnce(runtime, botId, sessionId, line).then(({ sent }) =>
    chosen ? { sent, chosen } : { sent }
  )
  told.set(slot, telling)
  const oldest = told.size > MAX_TOLD_CARD_ANSWERS ? told.keys().next().value : undefined
  if (oldest !== undefined) {
    told.delete(oldest)
  }
  const forget = (): void => {
    if (told.get(slot) === telling) {
      told.delete(slot)
    }
  }
  telling.then(({ sent }) => (sent ? undefined : forget()), forget)
  return telling
}

async function tellOnce(
  runtime: OrcaRuntimeService,
  botId: string,
  sessionId: string | undefined,
  line: string
): Promise<BotOfferTold> {
  if (sessionId) {
    // The host may have restarted since the card drew; an absent one would read every chat as no bot's.
    await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
    if (botOfSession(runtime.bots, sessionId)?.id !== botId) {
      throw new InvalidArgumentError("That chat isn't one of this bot's.")
    }
  }
  const chats = runtimeBotChats(runtime)
  const { outcome } = sessionId
    ? await chats.sendToSession(botId, sessionId, line, undefined, 'card-answer')
    : await chats.sendToChat(botId, line, 'card-answer')
  return { sent: outcome.kind !== 'refused' }
}

export const BOT_OFFER_ANSWER_METHOD = defineMethod({
  name: 'bots.offer.answer',
  permission: 'workspace',
  params: BotOfferAnswerParams,
  handler: async ({ botId, sessionId, text, answerKey, chosen }, context) => {
    ownerOnly(context, 'Only your owner answers offer cards, in Orca.')
    context.runtime.bots.assertEnabled()
    return tellBotCardAnswer(
      context.runtime,
      botId,
      sessionId,
      text,
      answerKey ? { answerKey, chosen } : undefined
    )
  }
})
