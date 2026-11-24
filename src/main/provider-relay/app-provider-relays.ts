import type { DaemonClient } from '../daemon/transport/client/daemon-client'
import type {
  ProviderRelayDetachPolicy,
  ProviderRelayWorkMarker,
  ProviderRelaySpawnSpec
} from '../daemon/protocol/daemon-provider-relay-protocol'
export { keptProviderRelaySpawnToken } from './provider-relay-launch-inventory'
import {
  forgetKeptProviderRelay,
  keptProviderRelay,
  listKeptProviderRelays,
  liveKeptProviderRelayChats,
  recheckKeptProviderRelay
} from './provider-relay-launch-inventory'
import type { ManagedProviderProcess } from '../provider-process/managed-provider-process'
import {
  resolveProviderChildEnv,
  type ProviderProcessLaunch
} from '../provider-process/provider-process-launch'
import { processEnvWithoutAgentSession } from '../../shared/agent-launch/startup/parent-agent-session-env'
import { resolveProviderExecPath } from '../provider-process/provider-exec-path'
import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import { providerRelayChannel, type ProviderRelayChannel } from './provider-relay-channel'
import { RelayedProviderChild } from './relayed-provider-child'
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

/**
 * What the open app's idle stop counts, as the daemon can see it: agent lines that open and close
 * turns and background tasks, and the app's own requests that are work until answered.
 */
export type ProviderRelayWorkMarkers = {
  markers: readonly ProviderRelayWorkMarker[]
  requests?: readonly string[]
}

/** The provider's open work at detach, keyed as its markers key it. */
export type ProviderRelayOpenWork = Record<string, string[][]>

export type ProviderRelayLaunch = {
  chatKey: string
  markers: ProviderRelayWorkMarkers
  /** Reattach only: lines this lets through while the rest wait for `releaseOutput()`. */
  passWhileHeld?: (line: string) => boolean
}

export type RelayedProviderProcess = {
  managed: ManagedProviderProcess
  child: RelayedProviderChild
  /** True when this chat's agent kept running from before this app started. */
  reattached: boolean
}

/** Quit waits at most this for detaches before disconnecting; a closing stream detaches anyway. */
const QUIT_DETACH_WAIT_MS = 5_000
const CONNECT_TIMEOUT_MS = 1_000

let route: ProviderRelayRoute | null = null
/** Every relay this app is attached to, by chat; quit detaches these instead of closing them. */
const attached = new Map<string, RelayedProviderChild>()
const markersFor = new WeakMap<RelayedProviderChild, ProviderRelayWorkMarkers>()
/** Attached children that kept running from before this app started. */
const reattachedChildren = new WeakSet<RelayedProviderChild>()
let quitting = false
let durableFor: ((chatKey: string) => Promise<void> | undefined) | null = null

export function installProviderRelayRoute(installed: ProviderRelayRoute | null): void {
  route = installed
}

/** The session host's journal barrier; acks wait on it so replay after a crash loses nothing. */
export function installProviderRelayDurability(
  barrier: ((chatKey: string) => Promise<void> | undefined) | null
): void {
  durableFor = barrier
}

function policyFor(
  markers: ProviderRelayWorkMarkers,
  open?: ProviderRelayOpenWork | null
): ProviderRelayDetachPolicy {
  return {
    idleStopMs: route?.idleStopMs() ?? null,
    markers: [...markers.markers],
    ...(markers.requests ? { workRequests: [...markers.requests] } : {}),
    ...(open ? { open } : {})
  }
}

/** Lists the daemons' kept relays once per launch (again after a daemon that didn't answer). */
export function listProviderRelaysAtLaunch(): Promise<void> {
  const installed = route
  return installed ? listKeptProviderRelays(() => installed.all()) : Promise.resolve()
}

/** Chats whose agent is still running under the daemon; restart offers must leave these alone. */
export function liveProviderRelayChats(): ReadonlySet<string> {
  return liveKeptProviderRelayChats()
}

/** The pid of the chat's agent the daemon kept running, until this app reattaches it. */
export function keptRunningProviderRelayPid(chatKey: string): number | null {
  const relay = keptProviderRelay(chatKey)
  return relay && relay.info.exit === null ? relay.info.pid : null
}

/** Ended relays found at launch are dropped once their chat cold-resumes. */
export function dropListedProviderRelay(chatKey: string): void {
  const relay = keptProviderRelay(chatKey)
  if (relay) {
    forgetKeptProviderRelay(chatKey, relay)
    void relay.channel.close(relay.info.relayId).catch(() => {})
  }
}

/** A kept agent that may still run must never get a second writer beside it. */
export class KeptProviderRelayUnreachableError extends Error {
  constructor(readonly chatKey: string) {
    super('agent_kept_running_unreachable')
    this.name = 'KeptProviderRelayUnreachableError'
  }
}

/** Chats being reattached at launch: a proven-gone agent ends the rebind instead of starting anew. */
const rebinding = new Set<string>()

export async function withProviderRelayRebind<T>(chatKey: string, run: () => Promise<T>) {
  rebinding.add(chatKey)
  try {
    return await run()
  } finally {
    rebinding.delete(chatKey)
  }
}

export class KeptProviderRelayEndedError extends Error {
  constructor(readonly chatKey: string) {
    super('agent_kept_running_ended')
    this.name = 'KeptProviderRelayEndedError'
  }
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

function spawnSpec(
  launch: ProviderProcessLaunch,
  client: DaemonClient
): ProviderRelaySpawnSpec | null {
  const identity = client.getDaemonIdentity()
  if (!route || !identity?.providerRelay || identity.appVersion !== route.appVersion) {
    return null
  }
  if (!launch.cwd) {
    return null
  }
  const env: Record<string, string> = {}
  const resolved = resolveProviderChildEnv(launch, processEnvWithoutAgentSession(process.platform))
  for (const [key, value] of Object.entries(resolved)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  return {
    command: launch.command,
    args: launch.args,
    cwd: launch.cwd,
    env,
    ownerExecutable: resolveProviderExecPath(),
    appVersion: route.appVersion,
    ...(identity.entryPath ? { entryPath: identity.entryPath } : {})
  }
}

/** On macOS the daemon may lack permission for the chat's folder; only a readable one relays. */
async function daemonReadsFolder(client: DaemonClient, cwd: string): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return true
  }
  try {
    const reply = await client.request<{ outcome?: unknown } | null>(
      'probeProviderCwd',
      { cwd },
      1_500
    )
    return reply?.outcome === 'ok'
  } catch {
    return false
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
  return new RelayedProviderChild({
    channel,
    relayId,
    pid,
    policy: () => policyFor(launch.markers),
    quitting: providerRelayQuitting,
    durable: () => durableFor?.(launch.chatKey) ?? Promise.resolve(),
    ...(passWhileHeld ? { passWhileHeld } : {})
  })
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
  if (info.exit === null && info.pid !== null && (await connected(channel.client))) {
    const child = relayedChild(channel, info.relayId, info.pid, launch, launch.passWhileHeld)
    // An agent that ended during the attach still counts: its last output reaches the chat first.
    const started = await child.start(info.ackedSeq).then(
      () => true,
      () => false
    )
    if (started) {
      forgetKeptProviderRelay(launch.chatKey, relay)
      reattachedChildren.add(child)
      track(launch.chatKey, child, launch.markers)
      return { managed: relayedManagedProcess(child), child, reattached: true }
    }
  }
  const verdict =
    info.exit === null ? await recheckKeptProviderRelay(launch.chatKey, relay) : 'gone'
  if (verdict !== 'gone') {
    throw new KeptProviderRelayUnreachableError(launch.chatKey)
  }
  forgetKeptProviderRelay(launch.chatKey, relay)
  void channel.close(info.relayId).catch(() => {})
  if (rebinding.has(launch.chatKey)) {
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
  if (!route) {
    return null
  }
  await listProviderRelaysAtLaunch()
  const kept = await reattachListed(relay)
  if (kept) {
    return kept
  }
  const client = await connected(await route.current().catch(() => null))
  const spec = client ? spawnSpec(launch, client) : null
  if (!client || !spec || !(await daemonReadsFolder(client, spec.cwd))) {
    return null
  }
  const channel = providerRelayChannel(client)
  let spawned: Awaited<ReturnType<ProviderRelayChannel['spawn']>>
  try {
    spawned = await channel.spawn(spec, relay.chatKey, policyFor(relay.markers))
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
  await child.detach(policyFor(markers, open)).catch(() => {})
  return true
}
