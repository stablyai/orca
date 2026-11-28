import type { ConnectorAnswer } from '../../shared/connectors/connector-cloud-contract'
import { currentChat } from './external-conversation-chat'
import { answerChatPrompt } from './external-conversation-chat-prompts'
import type { ConversationEvents } from './external-conversation-events'
import { requireLink } from './external-conversation-links'
import type { ExternalConversationHost } from './external-conversation-host'
import type { ExternalConversationSeamDeps } from './external-conversation-seam'
import { refused, type ConversationKey, type Delivery } from './external-conversation-types'

export type AnswerSeam = Pick<ExternalConversationSeamDeps, 'store'> & {
  events: ConversationEvents | null
}

/** A connector's answer to the prompt its conversation's agent shows. */
export async function answerConversation(
  host: ExternalConversationHost,
  seam: AnswerSeam,
  key: ConversationKey,
  answer: { promptId: string; signal: AbortSignal } & ConnectorAnswer
): Promise<Delivery> {
  if (answer.signal.aborted) {
    return refused('connectors_disabled')
  }
  const { link } = requireLink(seam.store, key)
  // An answer is a delivery too, so a bot's is checked against the bot (paused, gone, bots off).
  const botRefusal = link.bot && (host.bots ? host.bots.refusal(link.bot.botId) : 'bot_not_found')
  if (botRefusal) {
    return refused(botRefusal)
  }
  if (link.isolatedSlack) {
    return refused('prompt_unsupported')
  }
  // The cloud knows of its own answer, so it is never told as answered in Orca. Taken first: the
  // agent may work on before the answer settles.
  const keep = seam.events?.answering(link.paneKey, answer.promptId)
  // Kept unless it surely landed: an unproven one at worst reads answered in Orca, as before.
  let outcome: Delivery | null = null
  try {
    outcome = await answerChatPrompt(currentChat(host.chat), link, answer)
    return outcome
  } finally {
    if (outcome?.outcome !== 'accepted') {
      keep?.()
    }
  }
}
