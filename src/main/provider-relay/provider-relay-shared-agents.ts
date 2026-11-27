import type { ProviderRelayInfo } from '../daemon/protocol/daemon-provider-relay-protocol'
import type { KeptProviderRelay } from './provider-relay-launch-inventory'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'

/** `relay` null: the chat wasn't listed here, so every shared integration is told. `deleted`: its
 *  record as it was before deletion forgot it. */
export type SharedProviderRelayDropped = (
  chatKey: string,
  relay: KeptProviderRelay | null,
  deleted?: AgentSessionRecord
) => void
type Dropped = SharedProviderRelayDropped

/** Integrations whose one agent serves many chats: a chat's drop never closes it, its owner does. */
const sharedAgents = new Map<string, Dropped>()

/** Shared relays this app is attached to: each chat's run on one is still kept until it claims it. */
const sharedAttachedHere = new Set<string>()

export function registerSharedProviderRelayAgent(agent: string, dropped: Dropped): void {
  sharedAgents.set(agent, dropped)
}

export function providerRelayAgentShared(agent: string | null): boolean {
  return agent !== null && sharedAgents.has(agent)
}

/** Who hears a chat that no longer wants its part of a shared agent; undefined for any other. */
export function sharedProviderRelayDropped(agent: string | null): Dropped | undefined {
  return agent === null ? undefined : sharedAgents.get(agent)
}

/** This app attached (or let go of) a shared relay. */
export function noteSharedProviderRelayAttached(relayId: string, attachedHere: boolean): void {
  if (attachedHere) {
    sharedAttachedHere.add(relayId)
  } else {
    sharedAttachedHere.delete(relayId)
  }
}

/** Attached, but not by this app's own shared agent (whose chats still claim their parts). */
export function providerRelayAttachedByOther(info: ProviderRelayInfo): boolean {
  return info.attached && !sharedAttachedHere.has(info.relayId)
}

/** A deleted chat no relay was listed for: every shared integration hears it. */
export function sharedProviderRelayChatDropped(chatKey: string, deleted?: AgentSessionRecord) {
  for (const dropped of sharedAgents.values()) {
    dropped(chatKey, null, deleted)
  }
}
