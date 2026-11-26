import type { DaemonClient } from '../daemon/transport/client/daemon-client'
import type * as RelayProtocol from '../daemon/protocol/daemon-provider-relay-protocol'
import type { ProviderRelayWorkMarkers } from './provider-relay-agent-markers'
export {
  dropListedProviderRelay,
  keptProviderRelaySpawnToken,
  keptRunningProviderRelayPid,
  providerRelayKeptFromLastRun,
  providerRelayChatsIdleStoppedThisRun,
  liveKeptProviderRelayChats as liveProviderRelayChats,
  providerRelayInventoryCompleted,
  providerRelayKeptUnverified,
  registerReattachableProviderRelayAgent
} from './provider-relay-launch-inventory'
import {
  dropListedProviderRelay,
  forgetKeptProviderRelay,
  rememberKeptProviderRelay,
  keptProviderRelayAttachable,
  providerRelayAgentOpensEnded,
  noteProviderRelayReattachedFromLastRun,
  keptProviderRelay,
  listKeptProviderRelays,
  recheckKeptProviderRelay,
  providerRelayKeptUnverified,
  providerRelayMayKeep,
  providerRelayInventoryComplete as inventoryComplete
} from './provider-relay-launch-inventory'
import {
  KeptProviderRelayEndedError,
  KeptProviderRelayUnreachableError,
  providerRelayRebinding
} from './provider-relay-kept-rebind'
export { KeptProviderRelayEndedError, KeptProviderRelayUnreachableError }
export { withProviderRelayRebind } from './provider-relay-kept-rebind'
import type { ManagedProviderProcess } from '../provider-process/managed-provider-process'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import { providerRelayChannel, type ProviderRelayChannel } from './provider-relay-channel'
import { RelayedProviderChild } from './relayed-provider-child'
import { daemonReadsFolder, providerRelaySpawnSpec } from './provider-relay-spawn-request'
import { ProviderRelayCarriedWork } from './provider-relay-carried-work'
import { relayedManagedProcess } from './relayed-managed-process'

/** Desktop composition installs this on macOS and Linux; anywhere else chats launch as before. */
export type ProviderRelayRoute = {
  /** The daemon this app launched or adopted for its own bundle; the only one new chats go to. */
  current: () => Promise<DaemonClient | null>
  /** Every daemon generation, so relays kept by an older one are found at launch too. */
  all: () => Promise<DaemonClient[]>
  appVersion: string
  /** The user's native-chat idle stop, read at each attach and detach. */
  idleStopMs: () => number | null
}

export type { ProviderRelayWorkMarkers } from './provider-relay-agent-markers'

/** The provider's open work at detach, keyed as its markers key it. */
export type ProviderRelayOpenWork = Record<string, string[][]>

export type ProviderRelayLaunch = {
  chatKey: string
  markers: ProviderRelayWorkMarkers
  /** Reattach only: lines this lets through while the rest wait for `releaseOutput()`. */
  passWhileHeld?: (line: string) => boolean
  /** Session state the daemon keeps for the next attach; only a daemon that can keep it relays. */
  keep?: RelayProtocol.ProviderRelayKeepSpec
  /** A reattached agent closed during quit (its start given up) goes back to the daemon instead. */
  handsOffOnQuit?: true
}

export type RelayedProviderProcess = {
  managed: ManagedProviderProcess
  child: RelayedProviderChild
  /** True when this chat's agent kept running from before this app started. */
  reattached: boolean
  /** Reattach only: gives the agent back to the daemon, unread output kept, for a later open. */
  keep?: () => Promise<void>
}

/** Quit waits at most this for detaches before disconnecting; a closing stream detaches anyway. */
const QUIT_DETACH_WAIT_MS = 5_000
const CONNECT_TIMEOUT_MS = 1_000
/** How long one chat's hand-back waits for its paused reader, apart from quit's shared deadline. */
const KEEP_READER_WAIT_MS = 2_000

let route: ProviderRelayRoute | null = null
/** Every relay this app is attached to, by chat; quit detaches these instead of closing them. */
const attached = new Map<string, RelayedProviderChild>()
const markersFor = new WeakMap<RelayedProviderChild, ProviderRelayWorkMarkers>()
const carriedFor = new WeakMap<RelayedProviderChild, ProviderRelayCarriedWork>()
/** Attached children that kept running from before this app started. */
const reattachedChildren = new WeakSet<RelayedProviderChild>()
/** Chats whose reattached agent went back to the daemon unopened: its end here (the next one,
 *  once) ends nothing. Any later launch for the chat retires it, so a new agent's end settles. */
const handedBack = new Set<string>()
let quitting = false
let durableFor: ((chatKey: string, force: boolean) => Promise<boolean> | undefined) | null = null

export function installProviderRelayRoute(installed: ProviderRelayRoute | null): void {
  route = installed
}

/** The session host's journal barrier; acks wait on it so replay after a crash loses nothing. */
export function installProviderRelayDurability(barrier: typeof durableFor): void {
  durableFor = barrier
}

function policyFor(
  markers: ProviderRelayWorkMarkers,
  open?: ProviderRelayOpenWork | null
): RelayProtocol.ProviderRelayDetachPolicy {
  return {
    idleStopMs: route?.idleStopMs() ?? null,
    markers: [...markers.markers],
    ...(markers.requests ? { workRequests: [...markers.requests] } : {}),
    ...(markers.quiet ? { quiet: [...markers.quiet] } : {}),
    ...(markers.startApprovals ? { startApprovals: [...markers.startApprovals] } : {}),
    ...(open ? { open } : {})
  }
}

/** No agent can be kept where no relay route is installed (servers, SSH hosts). */
export function providerRelayInventoryComplete(): boolean {
  return !route || inventoryComplete()
}

/** Lists the daemons' kept relays once per launch (again after a daemon that didn't answer). */
export function listProviderRelaysAtLaunch(): Promise<void> {
  const installed = route
  return installed ? listKeptProviderRelays(() => installed.all()) : Promise.resolve()
}

/** Proves a chat opened as kept, that no listing placed, ended since; it settles that chat too. */
let keptUnverifiedProof: ((chatKey: string) => Promise<boolean>) | null = null

export function installProviderRelayKeptUnverifiedProof(proof: typeof keptUnverifiedProof): void {
  keptUnverifiedProof = proof
}

/** The shared launch listing, never asked again here: true once every daemon has answered. */
export async function providerRelayListingSettled(): Promise<boolean> {
  await listProviderRelaysAtLaunch()
  return inventoryComplete()
}

/** Whether this chat could have an agent kept here; no other chat waits on the listing. */
export function providerRelayMayKeepChat(provider: string, ownerOnLocalHost: boolean): boolean {
  return route !== null && providerRelayMayKeep(provider, ownerOnLocalHost)
}

/** True once every daemon answered within `ms`; false while the listing is late or incomplete. */
export function listProviderRelaysAtLaunchWithin(ms: number): Promise<boolean> {
  return withTimeout(
    listProviderRelaysAtLaunch().then(() => inventoryComplete()),
    ms,
    false
  )
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

function track(chatKey: string, child: RelayedProviderChild, markers: ProviderRelayWorkMarkers) {
  markersFor.set(child, markers)
  attached.set(chatKey, child)
  child.once('exit', () => {
    if (attached.get(chatKey) === child) {
      attached.delete(chatKey)
    }
  })
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
    durable: (force) => durableFor?.(launch.chatKey, force) ?? Promise.resolve(true),
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
      const handOff = () => (quitting ? detachProviderRelayForQuit(launch.chatKey, null) : null)
      const managed = relayedManagedProcess(child, launch.handsOffOnQuit ? handOff : undefined)
      return { managed, child, reattached: true, keep }
    }
  }
  const verdict =
    info.exit === null && !endedSince
      ? await recheckKeptProviderRelay(launch.chatKey, relay)
      : 'gone'
  if (verdict !== 'gone') {
    throw new KeptProviderRelayUnreachableError(launch.chatKey)
  }
  dropListedProviderRelay(launch.chatKey, true) // a failed attach never drops unread output
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
  const installed = route
  if (!installed) {
    return null
  }
  await listProviderRelaysAtLaunch()
  // Opened as kept while the listing was late: ask once more, and never start a second agent.
  if (!inventoryComplete() && providerRelayKeptUnverified(relay.chatKey)) {
    await listKeptProviderRelays(() => installed.all(), true)
    if (
      !inventoryComplete() &&
      !keptProviderRelay(relay.chatKey) &&
      !(await keptUnverifiedProof?.(relay.chatKey).catch(() => false))
    ) {
      throw new KeptProviderRelayUnreachableError(relay.chatKey)
    }
  }
  const kept = await reattachListed(relay)
  if (kept) {
    return kept
  }
  const client = await connected(await installed.current().catch(() => null))
  const spec = client ? providerRelaySpawnSpec(launch, client, installed.appVersion) : null
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
  return { managed: relayedManagedProcess(child), child, reattached: false }
}

/** From here a dropped daemon stream means quit, so relays stop trying to reattach. */
export function beginProviderRelayQuit(): void {
  quitting = true
}

export function providerRelayQuitting(): boolean {
  return quitting
}

/** Resolves when chat shutdown finished its detaches, at once when no chat is relayed. */
export function providerRelayDetachesSettled(shutdown: Promise<unknown>): Promise<void> {
  if (attached.size === 0) {
    return Promise.resolve()
  }
  return withTimeout(
    shutdown.then(
      () => {},
      () => {}
    ),
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
  return child !== undefined && reattachedChildren.has(child) && child.exited === null
}

/** True when quit should hand this chat's agent to the daemon rather than stop it. */
export function hasAttachedProviderRelay(chatKey: string): boolean {
  const child = attached.get(chatKey)
  return child !== undefined && child.exited === null && !child.handedOff
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
  const markers = child ? markersFor.get(child) : undefined
  if (!child || !markers || child.exited !== null) {
    return false
  }
  attached.delete(chatKey)
  // A failed detach request still hands the agent off: the closing stream detaches it daemon-side.
  await child.detach(policyFor(markers, carriedFor.get(child)?.merge(open) ?? open)).catch(() => {})
  return true
}
