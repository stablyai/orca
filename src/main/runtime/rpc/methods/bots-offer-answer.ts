// An owner's press on a card, told to the agent as a hidden card answer: it queues behind a running
// turn and draws as nothing, where a typed one could steer that turn under the owner's name.
import { BotOfferAnswerParams } from '../../../../shared/bots/bot-offer-answers'
import { runtimeBotChats } from '../../../bots/bot-chat-session'
import { botOfSession } from '../../../bots/bot-session-tabs'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod, InvalidArgumentError } from '../core'
import { ownerOnly } from './bots-caller-gates'

type CardAnswerTold = Promise<{ sent: boolean }>

// Card answers each host queued (or is queueing), by bot, chat and answer key. Enough for the presses one
// lost reply can repeat; a host restart forgets them, as it forgets the replies it never sent.
const MAX_TOLD_CARD_ANSWERS = 256
const toldCardAnswers = new WeakMap<OrcaRuntimeService, Map<string, CardAnswerTold>>()

/** Sends `line` as a card answer into `sessionId`, which must be one of the bot's chats, or into its Chat.
 *  With `answerKey`, a repeat of an answer this host queued (a press again after a lost reply, another
 *  window) returns that answer's result instead of telling the bot twice; a refused or failed one may go again. */
export function tellBotCardAnswer(
  runtime: OrcaRuntimeService,
  botId: string,
  sessionId: string | undefined,
  line: string,
  answerKey?: string
): CardAnswerTold {
  if (!answerKey) {
    return tellOnce(runtime, botId, sessionId, line)
  }
  let told = toldCardAnswers.get(runtime)
  if (!told) {
    told = new Map()
    toldCardAnswers.set(runtime, told)
  }
  const key = JSON.stringify([botId, sessionId ?? null, answerKey])
  const prior = told.get(key)
  if (prior) {
    return prior
  }
  const telling = tellOnce(runtime, botId, sessionId, line)
  told.set(key, telling)
  const oldest = told.size > MAX_TOLD_CARD_ANSWERS ? told.keys().next().value : undefined
  if (oldest !== undefined) {
    told.delete(oldest)
  }
  const forget = (): void => {
    if (told.get(key) === telling) {
      told.delete(key)
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
): CardAnswerTold {
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
  handler: async ({ botId, sessionId, text, answerKey }, context) => {
    ownerOnly(context, 'Only your owner answers offer cards, in Orca.')
    context.runtime.bots.assertEnabled()
    return tellBotCardAnswer(context.runtime, botId, sessionId, text, answerKey)
  }
})
