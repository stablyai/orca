// A linked chat deleted in Orca: its conversation's link goes, and a cloud that frees threads
// (threads.owner) is told, so the thread's next message starts a new chat.
import { CHAT_GONE_REFUSAL } from '../../shared/connectors/connector-cloud-contract'
import { linkedChat, type LinkableChat } from './external-conversation-chat-delivery'
import type { ExternalConversationHost } from './external-conversation-host'
import {
  findLink,
  removeLink,
  type ExternalConversationLinkStore,
  type LinkedConversation
} from './external-conversation-links'
import { refused, type ConversationKey, type Delivery } from './external-conversation-types'

export class GoneChats {
  constructor(
    private readonly deps: {
      store: ExternalConversationLinkStore
      /** The cloud frees a thread whose chat is gone (its hello lists threads.owner). */
      freesGoneChats?: () => boolean
      released: (dropped: LinkedConversation) => void
    }
  ) {}

  /** A send's outcome: one to a deleted chat frees its thread where the cloud takes that, and reads
   *  as unreachable to an older cloud, as before. */
  settle(key: ConversationKey, delivered: Delivery): Delivery {
    if (delivered.outcome !== 'refused' || delivered.reason !== CHAT_GONE_REFUSAL) {
      return delivered
    }
    if (!this.deps.freesGoneChats?.()) {
      return refused('agent_not_reachable')
    }
    this.release(key)
    return delivered
  }

  /** Drops a conversation's link to its deleted chat. */
  release(key: ConversationKey): void {
    const dropped = removeLink(this.deps.store, key)
    if (dropped) {
      this.deps.released(dropped)
    }
  }

  /** The chat eligible to receive automation input; 'gone' once that chat was deleted. */
  async linkedChatOf(
    host: Pick<ExternalConversationHost, 'chat'>,
    key: ConversationKey
  ): Promise<LinkableChat | 'gone' | null> {
    const linked = findLink(this.deps.store, key)
    if (!linked || linked.link.isolatedSlack) {
      return null
    }
    const chat = await host.chat?.ensure()
    if (chat && !chat.deps.store.getConversation(linked.link.sessionId)) {
      return 'gone'
    }
    return linkedChat(linked.workspace.worktreeId, linked.link)
  }
}
