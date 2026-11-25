import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import { currentChat, stopChat } from './external-conversation-chat'
import type { ConversationChain } from './external-conversation-chain'
import { findLink } from './external-conversation-links'
import type { ExternalConversationHost } from './external-conversation-host'
import type { ExternalConversationSeamDeps } from './external-conversation-seam'
import {
  conversationId,
  refused,
  type ConversationKey,
  type Delivery
} from './external-conversation-types'

// Refuse rather than claim cancellation when a host operation ignores abort.
export const CANCEL_SETTLE_TIMEOUT_MS = 5_000

export type CancelSeam = Pick<ExternalConversationSeamDeps, 'store'> & {
  chain: ConversationChain
}

/** Cancel queued work before stopping the chat, so nothing queued runs after the Stop. */
export async function cancelConversation(
  host: ExternalConversationHost,
  seam: CancelSeam,
  key: ConversationKey,
  signal: AbortSignal,
  /** A Stop bound to a turn: false once that turn is no longer current. */
  turnIsCurrent: () => boolean = () => true
): Promise<Delivery> {
  if (signal.aborted) {
    return refused('connectors_disabled')
  }
  const id = conversationId(key)
  const settling = seam.chain.cancel(id, 'conversation_cancelled')
  // A queued start links its chat before settling; wait before looking up the chat.
  const headRefused = settling
    ? await withTimeout<boolean | null>(settling, CANCEL_SETTLE_TIMEOUT_MS, null)
    : false
  if (signal.aborted) {
    return refused('connectors_disabled')
  }
  if (headRefused === null) {
    return refused('agent_not_reachable')
  }
  // Settling can outlast the bound turn; a later one is not this Stop's.
  if (!turnIsCurrent()) {
    return refused('turn_not_running')
  }
  const linked = findLink(seam.store, key)
  if (!linked) {
    // Only a refused start proves no unlinked agent needs stopping.
    if (headRefused) {
      return { outcome: 'accepted' }
    }
    if (settling) {
      return refused('agent_not_reachable')
    }
    throw new Error('external_conversation_not_found')
  }
  return stopChat(currentChat(host.chat), linked.link, signal)
}
