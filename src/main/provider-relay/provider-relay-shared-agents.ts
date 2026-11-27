import type { ProviderRelayInfo } from '../daemon/protocol/daemon-provider-relay-protocol'
import type { KeptProviderRelay } from './provider-relay-launch-inventory'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'

/** `relay` null: the chat wasn't listed here, so every shared integration is told. */
type Dropped = (chatKey: string, relay: KeptProviderRelay | null) => void

/** A shared integration's side of a chat: `dropped` hears one that no longer wants its part, and
 *  `stop` ends a chat's kept run before deletion (false: it may still run and can't be reached). */
export type SharedProviderRelayAgent = {
  dropped: Dropped
  stop?: (record: AgentSessionRecord) => Promise<boolean>
}

/** Integrations whose one agent serves many chats: a chat's drop never closes it, its owner does. */
const sharedAgents = new Map<string, SharedProviderRelayAgent>()

/** Shared relays this app is attached to: each chat's run on one is still kept until it claims it. */
const sharedAttachedHere = new Set<string>()

export function registerSharedProviderRelayAgent(
  agent: string,
  shared: SharedProviderRelayAgent
): void {
  sharedAgents.set(agent, shared)
}

export function providerRelayAgentShared(agent: string | null): boolean {
  return agent !== null && sharedAgents.has(agent)
}

/** Who hears a chat that no longer wants its part of a shared agent; undefined for any other. */
export function sharedProviderRelayDropped(agent: string | null): Dropped | undefined {
  return agent === null ? undefined : sharedAgents.get(agent)?.dropped
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
export function sharedProviderRelayChatDropped(chatKey: string): void {
  for (const { dropped } of sharedAgents.values()) {
    dropped(chatKey, null)
  }
}

/** Before a chat is deleted, each shared integration ends its kept run; false refuses the delete. */
export async function stopSharedProviderRelayRuns(record: AgentSessionRecord): Promise<boolean> {
  const stopped = await Promise.all(
    [...sharedAgents.values()].map(
      ({ stop }) => stop?.(record).catch(() => false) ?? Promise.resolve(true)
    )
  )
  return stopped.every(Boolean)
}
