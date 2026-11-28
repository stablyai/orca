import type { ProviderRelayInfo } from '../daemon/protocol/daemon-provider-relay-protocol'
import type { KeptProviderRelay } from './provider-relay-launch-inventory'

/** `relay` null: the chat wasn't listed here, so every shared integration is told. */
type Dropped = (chatKey: string, relay: KeptProviderRelay | null) => void

/** A shared integration's side of a chat: `dropped` hears one that no longer wants its part. */
export type SharedProviderRelayAgent = {
  dropped: Dropped
  /** Whether the chat still has a part (a lease, held threads, a stop under way) on this relay,
   *  which this app holds attached; false once its part ended though others keep the agent. */
  holds?: (chatKey: string, relayId: string) => boolean
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

/** A chat whose part of a shared agent this app holds attached has ended, though the agent runs on
 *  for other chats: its run is over. */
export function sharedProviderRelayPartEnded(chatKey: string, info: ProviderRelayInfo): boolean {
  const agent = info.agent === null ? undefined : sharedAgents.get(info.agent)
  return sharedAttachedHere.has(info.relayId) && agent?.holds?.(chatKey, info.relayId) === false
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
