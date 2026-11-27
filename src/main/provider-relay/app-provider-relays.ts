import type { DaemonClient } from '../daemon/transport/client/daemon-client'
export {
  dropListedProviderRelay,
  keptProviderRelaySpawnToken,
  keptRunningProviderRelayPid,
  providerRelayKeptFromLastRun,
  providerRelayChatsIdleStoppedThisRun,
  forgetProviderRelayRunVerdict,
  providerRelayRunUnknown,
  registerReattachableProviderRelayAgent
} from './provider-relay-launch-inventory'
import {
  forgetKeptProviderRelay,
  rememberKeptProviderRelay,
  keptProviderRelayAttachable,
  keptProviderRelayUnread,
  providerRelayAgentOpensEnded,
  noteProviderRelayReattachedFromLastRun,
  keptProviderRelay,
  listKeptProviderRelays,
  providerRelayMayKeep,
  type KeptProviderRelay
} from './provider-relay-launch-inventory'
export { type KeptProviderRelay, keptProviderRelay } from './provider-relay-launch-inventory'
import { providerRelayRoute } from './provider-relay-route'
import { providerRelayRunGate } from './provider-relay-run-liveness'
import {
  forgetProviderRelayRunPlacement,
  noteProviderRelayRunPlacement
} from './provider-relay-run-placements'
export { installProviderRelayRoute, type ProviderRelayRoute } from './provider-relay-route'
export {
  installProviderRelayRunGate,
  providerRelayRunLiveness,
  type ProviderRelayRunLiveness,
  type ProviderRelayRunRecord
} from './provider-relay-run-liveness'
export {
  setProviderRelayRunPlacement,
  takeProviderRelayRunPlacement
} from './provider-relay-run-placements'
import {
  attached,
  carriedFor,
  handedBack,
  policyFor,
  providerRelayQuitting,
  reattachedChildren,
  relayOf,
  track,
  detachProviderRelayForQuit
} from './provider-relay-attached-agents'
export {
  beginProviderRelayQuit,
  detachProviderRelayForQuit,
  hasAttachedProviderRelay,
  providerRelayDetachesSettled,
  providerRelayHandedOffAtQuit,
  providerRelayQuitting,
  providerRelayReattached,
  providerRelayRunOutlivesQuit,
  takeProviderRelayHandedBack,
  type ProviderRelayOpenWork
} from './provider-relay-attached-agents'
export {
  onProviderRelayQuit,
  registerPooledProviderRelayChat,
  trackProviderRelayQuitWork,
  type PooledProviderRelayChat
} from './provider-relay-pooled-chats'
import {
  KeptProviderRelayEndedError,
  KeptProviderRelayUnreachableError,
  providerRelayRebinding
} from './provider-relay-kept-rebind'
export { KeptProviderRelayEndedError, KeptProviderRelayUnreachableError }
export { withProviderRelayRebind } from './provider-relay-kept-rebind'
import type { ManagedProviderProcess } from '../provider-process/managed-provider-process'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import { providerRelayChannel, type ProviderRelayChannel } from './provider-relay-channel'
import { RelayedProviderChild } from './relayed-provider-child'
import { daemonReadsFolder, providerRelaySpawnSpec } from './provider-relay-spawn-request'
import { ProviderRelayCarriedWork } from './provider-relay-carried-work'
import { relayedManagedProcess } from './relayed-managed-process'

export type { ProviderRelayWorkMarkers } from './provider-relay-agent-markers'

import type { ProviderRelayLaunch } from './provider-relay-launch'
export type { ProviderRelayLaunch }

export type RelayedProviderProcess = {
  managed: ManagedProviderProcess
  child: RelayedProviderChild
  /** True when this chat's agent kept running from before this app started. */
  reattached: boolean
  /** Reattach only: gives the agent back to the daemon, unread output kept, for a later open. */
  keep?: () => Promise<void>
}

const CONNECT_TIMEOUT_MS = 1_000
/** How long one chat's hand-back waits for its paused reader, apart from quit's shared deadline. */
const KEEP_READER_WAIT_MS = 2_000
let durableFor: ((chatKey: string, force: boolean) => Promise<boolean> | undefined) | null = null

export const providerRelayRouteInstalled = (): boolean => providerRelayRoute() !== null

/** The session host's journal barrier; acks wait on it so replay after a crash loses nothing. */
export function installProviderRelayDurability(barrier: typeof durableFor): void {
  durableFor = barrier
}

/** One chat's journal barrier, for an agent that serves several chats and acks for all of them. */
export function providerRelayChatDurable(chatKey: string, force: boolean): Promise<boolean> {
  return durableFor?.(chatKey, force) ?? Promise.resolve(true)
}

/** Lists the daemons' kept relays once per launch (again after a daemon that didn't answer). */
export function listProviderRelaysAtLaunch(): Promise<void> {
  const installed = providerRelayRoute()
  return installed ? listKeptProviderRelays(() => installed.all()) : Promise.resolve()
}

/** Whether this chat could have an agent kept here; no other chat waits on a daemon. */
export function providerRelayMayKeepChat(provider: string, ownerOnLocalHost: boolean): boolean {
  return providerRelayRoute() !== null && providerRelayMayKeep(provider, ownerOnLocalHost)
}

async function connected(client: DaemonClient | null): Promise<DaemonClient | null> {
  if (!client) {
    return null
  }
  try {
    await client.ensureConnectedWithin(CONNECT_TIMEOUT_MS)
    return client
  } catch {
    return null
  }
}

/**
 * A shared agent kept from before this app started, attached once for every chat it serves from
 * its last acked line. Null when it can't be attached now; the caller decides what that means.
 */
async function attachSharedRelay(
  relay: KeptProviderRelay,
  launch: ProviderRelayLaunch
): Promise<RelayedProviderProcess | null> {
  const { channel, info } = relay
  if (!keptProviderRelayAttachable(info) || !(await connected(channel.client))) {
    return null
  }
  const child = relayedChild(channel, info.relayId, info.pid, launch, launch.passWhileHeld)
  const attach = await child.start(info.ackedSeq).catch(() => null)
  if (!attach || attach.exit !== null) {
    channel.release(info.relayId)
    return null
  }
  relayOf.set(child, relay)
  reattachedChildren.add(child)
  carriedFor.get(child)?.take(child.attachResult?.openWork)
  track(launch.chatKey, child, launch.markers)
  return { managed: relayedManagedProcess(child), child, reattached: true }
}

function relayedChild(
  channel: ProviderRelayChannel,
  relayId: string,
  pid: number,
  launch: ProviderRelayLaunch,
  passWhileHeld?: (line: string) => boolean
): RelayedProviderChild {
  const carried = new ProviderRelayCarriedWork(launch.markers.markers)
  const child = new RelayedProviderChild({
    channel,
    relayId,
    pid,
    policy: () => policyFor(launch.markers),
    quitting: providerRelayQuitting,
    durable: launch.durable ?? ((force) => providerRelayChatDurable(launch.chatKey, force)),
    ackFloor: carried.withFloor(launch.markers.ackFloor?.()),
    ...(launch.markers.continuation ? { continuation: launch.markers.continuation } : {}),
    ...(passWhileHeld ? { passWhileHeld } : {})
  })
  carriedFor.set(child, carried)
  return child
}

/**
 * The chat's agent kept from before this app started, attached from its last acked line. The
 * inventory row stays until the attach works or the daemon proves the agent gone; anything in
 * between refuses the start, so no second writer runs beside a kept agent.
 */
async function reattachListed(launch: ProviderRelayLaunch): Promise<RelayedProviderProcess | null> {
  const relay = keptProviderRelay(launch.chatKey)
  if (!relay) {
    return null
  }
  const { channel, info } = relay
  let endedSince = false
  if (keptProviderRelayAttachable(info) && (await connected(channel.client))) {
    const child = relayedChild(channel, info.relayId, info.pid, launch, launch.passWhileHeld)
    const attach = await child.start(info.ackedSeq).catch(() => null)
    // An agent that ended can't answer the chat's open, unless its integration opens ended ones.
    endedSince = (attach?.exit ?? null) !== null && !providerRelayAgentOpensEnded(info.agent)
    if (attach && !endedSince) {
      forgetKeptProviderRelay(launch.chatKey, relay)
      relayOf.set(child, relay)
      noteProviderRelayRunPlacement(launch.chatKey, channel.client, info.relayId)
      reattachedChildren.add(child)
      noteProviderRelayReattachedFromLastRun(launch.chatKey)
      handedBack.delete(launch.chatKey)
      carriedFor.get(child)?.take(child.attachResult?.openWork)
      track(launch.chatKey, child, launch.markers)
      const keep = async (): Promise<void> => {
        // A failed detach request still hands the agent off (as at quit); it is listed again
        // either way, so the next open reattaches it rather than starting a second agent.
        await child.detach(policyFor(launch.markers), KEEP_READER_WAIT_MS).catch(() => {})
        child.dropHeldOutput()
        if (attached.get(launch.chatKey) === child) {
          attached.delete(launch.chatKey)
        }
        rememberKeptProviderRelay(launch.chatKey, relay)
        handedBack.add(launch.chatKey)
      }
      // A reattached agent is relayed before its placement commits: quit hands it back even then.
      const handOff = () =>
        providerRelayQuitting() ? detachProviderRelayForQuit(launch.chatKey, null) : null
      const managed = relayedManagedProcess(child, handOff)
      return { managed, child, reattached: true, keep }
    }
    // Nothing takes this attach's held output: it goes, so the channel keeps none of it.
    channel.release(info.relayId)
  }
  // A failed attach asks the run's daemon start again; only its word (or proof) ends the run.
  const verdict =
    info.exit === null && !endedSince
      ? await providerRelayRunGate(launch.chatKey, 'unknown')
      : 'gone'
  if (verdict !== 'gone') {
    throw new KeptProviderRelayUnreachableError(launch.chatKey)
  }
  forgetKeptProviderRelay(launch.chatKey, relay)
  // A failed attach never drops unread output.
  if (!keptProviderRelayUnread(info)) {
    void channel.close(info.relayId).catch(() => {})
  }
  if (providerRelayRebinding(launch.chatKey)) {
    throw new KeptProviderRelayEndedError(launch.chatKey)
  }
  return null
}

/**
 * Starts the chat's agent under the daemon, or reattaches the one it kept running. Null means
 * relaying isn't available here (old or other-bundle daemon, unreadable folder, refused), and
 * the caller launches the agent itself exactly as before.
 */
export async function launchRelayedProviderProcess(
  launch: ProviderProcessLaunch,
  relay: ProviderRelayLaunch
): Promise<RelayedProviderProcess | null> {
  handedBack.delete(relay.chatKey)
  forgetProviderRelayRunPlacement(relay.chatKey)
  const installed = providerRelayRoute()
  if (!installed) {
    return null
  }
  if (relay.attach) {
    return attachSharedRelay(relay.attach, relay)
  }
  // Only the last run's own daemon start (or proof) says whether a second agent may start.
  const verdict = await providerRelayRunGate(relay.chatKey, 'gone')
  // Kept but not ours to attach (another app holds it) is as unreachable as an unanswered daemon.
  if (verdict === 'unknown' || (verdict === 'kept' && !keptProviderRelay(relay.chatKey))) {
    throw new KeptProviderRelayUnreachableError(relay.chatKey)
  }
  // A launch reattach whose kept agent ended since ends as gone, so its cut turn gets its offer.
  if (verdict === 'gone' && providerRelayRebinding(relay.chatKey)) {
    throw new KeptProviderRelayEndedError(relay.chatKey)
  }
  if (relay.only === 'spawn' && keptProviderRelay(relay.chatKey)) {
    throw new KeptProviderRelayUnreachableError(relay.chatKey)
  }
  const kept = relay.only === 'spawn' ? null : await reattachListed(relay)
  if (kept || relay.only === 'reattach') {
    return kept
  }
  const client = await connected(await installed.current().catch(() => null))
  const spec = client ? providerRelaySpawnSpec(launch, client, installed.appVersion, relay) : null
  // Without kept state a reattach would have nothing to restore, so such a launch goes as today.
  const keeps = !relay.keep || client?.getDaemonIdentity()?.providerRelayKeep === true
  if (!client || !spec || !keeps || !(await daemonReadsFolder(client, spec.cwd))) {
    return null
  }
  const channel = providerRelayChannel(client)
  let spawned: Awaited<ReturnType<ProviderRelayChannel['spawn']>>
  try {
    const { chatKey, markers, keep } = relay
    spawned = await channel.spawn(spec, chatKey, policyFor(markers), markers.agent, keep)
  } catch {
    // An unanswered spawn may still have started the agent; the daemon ends it once no one attaches.
    return null
  }
  if (!('relayId' in spawned)) {
    return null
  }
  const child = relayedChild(channel, spawned.relayId, spawned.pid, relay)
  try {
    await child.start(0)
  } catch {
    void channel.close(spawned.relayId).catch(() => {})
    return null
  }
  track(relay.chatKey, child, relay.markers)
  noteProviderRelayRunPlacement(relay.chatKey, client, spawned.relayId, spawned.daemonInstance)
  return { managed: relayedManagedProcess(child), child, reattached: false }
}
