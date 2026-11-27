import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import {
  forgetKeptProviderRelay,
  forgetProviderRelayRunVerdict,
  keptProviderRelay,
  keptProviderRelayUnread
} from './provider-relay-launch-inventory'
import {
  sharedProviderRelayChatDropped,
  sharedProviderRelayDropped
} from './provider-relay-shared-agents'

/** Ended relays found at launch are dropped once their chat cold-resumes. */
/** `keepUnread`: output no app took stays with the daemon (it expires there); a deleted chat drops it. */
/** `deleted`: the chat's record as it was, so a shared agent not attached here can still end its part. */
export function dropListedProviderRelay(
  chatKey: string,
  keepUnread = false,
  deleted?: AgentSessionRecord
): void {
  if (!keepUnread) {
    forgetProviderRelayRunVerdict(chatKey)
  }
  const relay = keptProviderRelay(chatKey)
  if (!relay && !keepUnread) {
    // Its part of a shared agent, attached here or not yet, goes too.
    sharedProviderRelayChatDropped(chatKey, deleted)
  }
  if (relay) {
    forgetKeptProviderRelay(chatKey, relay)
    const shared = sharedProviderRelayDropped(relay.info.agent)
    if (shared) {
      // Other chats still ride it: only this chat's part goes.
      shared(chatKey, relay, deleted)
    } else if (!keepUnread || !keptProviderRelayUnread(relay.info)) {
      void relay.channel.close(relay.info.relayId).catch(() => {})
    }
  }
}
