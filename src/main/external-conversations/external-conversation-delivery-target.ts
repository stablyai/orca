import { botChatFor } from './external-conversation-bots'
import {
  linkedChat,
  type ChatDeliveries,
  type ConnectorChatDelivery,
  type LinkableChat
} from './external-conversation-chat-delivery'
import type {
  ExternalConversationHost,
  ExternalConversationSeamDeps
} from './external-conversation-host'
import { recordLastTurn } from './external-conversation-last-turn'
import type {
  ExternalConversationLinkStore,
  LinkedConversation
} from './external-conversation-links'
import { resumeRefusal } from './external-conversation-resume'
import type { ConnectorMessage, ConversationKey, Delivery } from './external-conversation-types'

export async function chatForConversationSend(
  store: ExternalConversationLinkStore,
  host: ExternalConversationHost,
  key: ConversationKey,
  linked: LinkedConversation,
  message: ConnectorMessage
): Promise<LinkableChat | Delivery> {
  const { workspace, link } = linked
  const chat = link.bot
    ? await botChatFor(store, host.bots, key, link.bot)
    : linkedChat(workspace.worktreeId, link)
  return 'outcome' in chat
    ? chat
    : ((await resumeRefusal(message, host.chat, chat.sessionId, linked)) ?? chat)
}

export async function sendConnectorChat(
  deps: Pick<ExternalConversationSeamDeps, 'store' | 'onLinked' | 'askerImages' | 'replyAdmitted'>,
  deliveries: ChatDeliveries,
  host: ExternalConversationHost,
  key: ConversationKey,
  chat: LinkableChat,
  delivery: ConnectorChatDelivery
): Promise<Delivery> {
  const delivered = await deliveries.deliver(host.chat, key, chat, {
    ...delivery,
    ...(deps.askerImages ? { askerImages: deps.askerImages } : {})
  })
  // Its outbox row may have committed even when the send was then rejected.
  if (delivery.reply) {
    deps.replyAdmitted?.(chat.sessionId)
  }
  if (delivered.outcome === 'accepted' || delivered.outcome === 'unknown') {
    recordLastTurn(deps, key, 'conversation', { worktreeId: chat.worktreeId, sshHostId: null })
  }
  return delivered
}
