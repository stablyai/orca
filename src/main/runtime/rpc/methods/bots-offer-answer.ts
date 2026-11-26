// An owner's press on a card, told to the agent as a hidden card answer: it queues behind a running
// turn and draws as nothing, where a typed one could steer that turn under the owner's name.
import { BotOfferAnswerParams } from '../../../../shared/bots/bot-offer-answers'
import { runtimeBotChats } from '../../../bots/bot-chat-session'
import { botOfSession } from '../../../bots/bot-session-tabs'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod, InvalidArgumentError } from '../core'
import { ownerOnly } from './bots-caller-gates'

/** Sends `line` as a card answer into `sessionId`, which must be one of the bot's chats, or into its Chat. */
export async function tellBotCardAnswer(
  runtime: OrcaRuntimeService,
  botId: string,
  sessionId: string | undefined,
  line: string
): Promise<{ sent: boolean }> {
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
  handler: async ({ botId, sessionId, text }, context) => {
    ownerOnly(context, 'Only your owner answers offer cards, in Orca.')
    context.runtime.bots.assertEnabled()
    return tellBotCardAnswer(context.runtime, botId, sessionId, text)
  }
})
