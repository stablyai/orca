// An offer card's Not now: the bot hears "Dismiss" as a card answer. It queues behind a running turn
// and draws as nothing, where a typed one could steer that turn under the owner's name.
import { BotOfferDismiss } from '../../../../shared/bots/bot-offer-answers'
import { runtimeBotChats } from '../../../bots/bot-chat-session'
import { botOfSession } from '../../../bots/bot-session-tabs'
import { defineMethod, InvalidArgumentError } from '../core'
import { ownerOnly } from './bots-caller-gates'

export const BOT_OFFER_DISMISS_METHOD = defineMethod({
  name: 'bots.offer.dismiss',
  permission: 'workspace',
  params: BotOfferDismiss,
  handler: async ({ botId, sessionId }, context) => {
    ownerOnly(context, 'Only your owner answers offer cards, in Orca.')
    context.runtime.bots.assertEnabled()
    if (sessionId) {
      // An absent host would read every chat as no bot's.
      await context.runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
      if (botOfSession(context.runtime.bots, sessionId)?.id !== botId) {
        throw new InvalidArgumentError("That chat isn't one of this bot's.")
      }
    }
    const chats = runtimeBotChats(context.runtime)
    const { outcome } = sessionId
      ? await chats.sendToSession(botId, sessionId, 'Dismiss', undefined, 'card-answer')
      : await chats.sendToChat(botId, 'Dismiss', 'card-answer')
    return { sent: outcome.kind !== 'refused' }
  }
})
