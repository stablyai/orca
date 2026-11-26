import type { ConnectorAsker } from '../../shared/connectors/connector-cloud-contract'
import { isBotAgent } from '../../shared/bot-types'
import { botChatFor, deliveryChatId } from './external-conversation-bots'
import type { ConnectorChatDelivery, LinkableChat } from './external-conversation-chat-delivery'
import type { DeliveryPreparation } from './external-conversation-delivery-preparation'
import type {
  ExternalConversationHost,
  ExternalConversationSeamDeps
} from './external-conversation-host'
import { findLink } from './external-conversation-links'
import {
  refused,
  type ConnectorStartInput,
  type ConversationKey,
  type ConversationStart,
  type Delivery
} from './external-conversation-types'

export async function startConnectorConversation(
  deps: Pick<ExternalConversationSeamDeps, 'store' | 'receipts'> & {
    enqueue(run: (signal: AbortSignal) => Promise<Delivery>): Promise<Delivery>
    deliver(chat: LinkableChat, delivery: ConnectorChatDelivery): Promise<Delivery>
    link(chat: LinkableChat, text: string, asker?: ConnectorAsker): void
  },
  host: ExternalConversationHost,
  key: ConversationKey,
  deliveryId: string,
  input: ConnectorStartInput,
  preparation?: DeliveryPreparation
): Promise<ConversationStart> {
  const { agent, target, prompt, ...message } = input
  const initial = await deps.receipts.run(
    key,
    deliveryId,
    'connector.start',
    [agent, target, prompt],
    () =>
      deps.enqueue(async (signal) => {
        const stopped = preparation?.stopped(preparation.signal(signal))
        if (stopped) {
          return stopped
        }
        if (!isBotAgent(agent)) {
          return refused('unsupported_agent')
        }
        const chat = await botChatFor(
          deps.store,
          host.bots,
          key,
          target,
          preparation ? deliveryId : undefined
        )
        return 'outcome' in chat
          ? chat
          : deps.deliver(chat, { ...message, text: prompt, deliveryId, signal })
      }),
    preparation
  )
  if (
    preparation &&
    target.kind === 'bot' &&
    initial.outcome === 'accepted' &&
    !findLink(deps.store, key)
  ) {
    // The journal may have committed before the thread link was written.
    const sessionId = deliveryChatId(key, target, deliveryId)
    const chat = host.chat?.current()?.deps.store.getConversation(sessionId)
    if (chat?.location && chat.agent && isBotAgent(chat.agent)) {
      deps.link(
        { sessionId, agent: chat.agent, worktreeId: chat.location.workspaceId, bot: target },
        message.asker?.text ?? prompt,
        message.asker
      )
    }
  }
  return { conversation: key, initial }
}
