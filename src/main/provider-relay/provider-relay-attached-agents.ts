import type * as RelayProtocol from '../daemon/protocol/daemon-provider-relay-protocol'
import type { ProviderRelayWorkMarkers } from './provider-relay-agent-markers'
import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import { providerRelayRoute } from './provider-relay-route'
import { RELAYED_CHILD_HANDED_OFF, type RelayedProviderChild } from './relayed-provider-child'
import type { ProviderRelayCarriedWork } from './provider-relay-carried-work'
import {
  rememberKeptProviderRelay,
  type KeptProviderRelay
} from './provider-relay-launch-inventory'
import {
  noteSharedProviderRelayAttached,
  providerRelayAgentShared
} from './provider-relay-shared-agents'
import {
  pooledProviderRelayChat,
  pooledProviderRelayChatsPresent,
  providerRelayQuitWorkSettled,
  runProviderRelayQuitListeners
} from './provider-relay-pooled-chats'

/** The provider's open work at detach, keyed as its markers key it. */
export type ProviderRelayOpenWork = Record<string, string[][]>

/** Quit waits at most this for detaches before disconnecting; a closing stream detaches anyway. */
const QUIT_DETACH_WAIT_MS = 5_000

/** Every relay this app is attached to, by chat; quit detaches these instead of closing them. */
export const attached = new Map<string, RelayedProviderChild>()
export const markersFor = new WeakMap<RelayedProviderChild, ProviderRelayWorkMarkers>()
export const carriedFor = new WeakMap<RelayedProviderChild, ProviderRelayCarriedWork>()
/** The listed relay a reattached child came from, re-listed if a quit hands it back. */
export const relayOf = new WeakMap<RelayedProviderChild, KeptProviderRelay>()
/** Attached children that kept running from before this app started. */
export const reattachedChildren = new WeakSet<RelayedProviderChild>()
/** Chats whose reattached agent went back to the daemon unopened: its end here (the next one,
 *  once) ends nothing. Any later launch for the chat retires it, so a new agent's end settles. */
export const handedBack = new Set<string>()
let quitting = false

export function policyFor(
  markers: ProviderRelayWorkMarkers,
  open?: ProviderRelayOpenWork | null
): RelayProtocol.ProviderRelayDetachPolicy {
  return {
    idleStopMs: providerRelayRoute()?.idleStopMs() ?? null,
    markers: [...markers.markers],
    ...(markers.requests ? { workRequests: [...markers.requests] } : {}),
    ...(markers.quiet ? { quiet: [...markers.quiet] } : {}),
    ...(markers.startApprovals ? { startApprovals: [...markers.startApprovals] } : {}),
    ...(open ? { open } : {})
  }
}

export function track(
  chatKey: string,
  child: RelayedProviderChild,
  markers: ProviderRelayWorkMarkers
) {
  markersFor.set(child, markers)
  attached.set(chatKey, child)
  child.once('exit', () => {
    if (attached.get(chatKey) === child) {
      attached.delete(chatKey)
    }
  })
  if (providerRelayAgentShared(markers.agent)) {
    noteSharedProviderRelayAttached(child.relayId, true)
    const letGo = () => noteSharedProviderRelayAttached(child.relayId, false)
    child.once('exit', letGo)
    child.once(RELAYED_CHILD_HANDED_OFF, letGo)
  }
}

/** From here a dropped daemon stream means quit, so relays stop trying to reattach. */
export function beginProviderRelayQuit(): void {
  quitting = true
  runProviderRelayQuitListeners()
}

export function providerRelayQuitting(): boolean {
  return quitting
}

/**
 * At quit, a relayed run (its connection rides a relay) goes on under its daemon, so the app writes
 * no turn end for it; only a run that started in this app ends with the quit. Every provider reads
 * this with where its run started, not a flag of its own.
 */
export function providerRelayRunOutlivesQuit(placement: 'direct' | 'relayed'): boolean {
  return quitting && placement === 'relayed'
}

/** Resolves when chat shutdown finished its detaches, at once when no chat is relayed. */
export function providerRelayDetachesSettled(shutdown: Promise<unknown>): Promise<void> {
  if (attached.size === 0 && !pooledProviderRelayChatsPresent()) {
    return Promise.resolve()
  }
  return withTimeout(
    shutdown.then(providerRelayQuitWorkSettled, providerRelayQuitWorkSettled),
    QUIT_DETACH_WAIT_MS,
    undefined
  )
}

/** True once, for the local end of the agent just handed back to the daemon still running. */
export function takeProviderRelayHandedBack(chatKey: string): boolean {
  return handedBack.delete(chatKey)
}

/** The chat's attached agent kept running from before this app started (same writer, same turn). */
export function providerRelayReattached(chatKey: string): boolean {
  const child = attached.get(chatKey)
  if (child === undefined) {
    return pooledProviderRelayChat(chatKey)?.reattached() === true
  }
  return reattachedChildren.has(child) && child.exited === null
}

/** True when quit should hand this chat's agent to the daemon rather than stop it. */
export function hasAttachedProviderRelay(chatKey: string): boolean {
  const child = attached.get(chatKey)
  if (child === undefined) {
    return pooledProviderRelayChat(chatKey)?.keepable() === true
  }
  return child.exited === null && !child.handedOff
}

/**
 * Hands the chat's agent to the daemon; it keeps working and the next launch reattaches it. Without
 * `open` (a provider that can't say what work is open) the daemon never idle-stops it.
 */
export async function detachProviderRelayForQuit(
  chatKey: string,
  open: ProviderRelayOpenWork | null
): Promise<boolean> {
  const child = attached.get(chatKey)
  const pooled = child ? undefined : pooledProviderRelayChat(chatKey)
  if (pooled) {
    if (!pooled.keepable()) {
      return false
    }
    handedOffAtQuit.add(chatKey)
    return pooled.detachForQuit(open)
  }
  const markers = child ? markersFor.get(child) : undefined
  if (!child || !markers || child.exited !== null) {
    return false
  }
  attached.delete(chatKey)
  handedOffAtQuit.add(chatKey)
  // Listed again, as a hand-back is: a reattach this quit abandons still finds its relay.
  const relay = relayOf.get(child)
  if (relay) {
    rememberKeptProviderRelay(chatKey, relay)
  }
  // A failed detach request still hands the agent off: the closing stream detaches it daemon-side.
  await child.detach(policyFor(markers, carriedFor.get(child)?.merge(open) ?? open)).catch(() => {})
  return true
}

/** Chats whose agent this quit handed to its daemon; the process ends with the quit. */
const handedOffAtQuit = new Set<string>()

/** Handed to its daemon during this quit: its session ends without writing a turn end. */
export function providerRelayHandedOffAtQuit(chatKey: string): boolean {
  return handedOffAtQuit.has(chatKey)
}
