import type { DaemonClient } from '../daemon/transport/client/daemon-client'
import type {
  ProviderRelayDetachPolicy,
  ProviderRelayInfo,
  ProviderRelaySpawnSpec
} from '../daemon/protocol/daemon-provider-relay-protocol'
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

/** What starts and ends a provider's work, so the daemon never idle-stops a running turn. */
export type ProviderRelayWorkMarkers = { workStarts: string[]; workEnds: string[] }

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

type ListedRelay = { channel: ProviderRelayChannel; info: ProviderRelayInfo }

const LAUNCH_LIST_TIMEOUT_MS = 3_000
/** Launch waits this long for the daemon before treating every chat as having no kept agent. */
const LAUNCH_DAEMON_WAIT_MS = 10_000
/** Quit waits at most this for detaches before disconnecting; a closing stream detaches anyway. */
const QUIT_DETACH_WAIT_MS = 5_000
const CONNECT_TIMEOUT_MS = 1_000

let route: ProviderRelayRoute | null = null
/** Relays found at launch, by chat, until their chat rebinds or they are dropped. */
const listed = new Map<string, ListedRelay>()
let listing: Promise<void> | null = null
/** Every relay this app is attached to, by chat; quit detaches these instead of closing them. */
const attached = new Map<string, RelayedProviderChild>()
const markersFor = new WeakMap<RelayedProviderChild, ProviderRelayWorkMarkers>()
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

function policyFor(markers: ProviderRelayWorkMarkers, working = false): ProviderRelayDetachPolicy {
  return { idleStopMs: route?.idleStopMs() ?? null, working, ...markers }
}

/** One `relayList` per daemon, once; later launches and the restart offer read the result. */
export function listProviderRelaysAtLaunch(): Promise<void> {
  const installed = route
  if (!installed) {
    return Promise.resolve()
  }
  listing ??= (async () => {
    const clients = await withTimeout(
      installed.all().catch(() => []),
      LAUNCH_DAEMON_WAIT_MS,
      [] as DaemonClient[]
    )
    await Promise.all(
      clients.map(async (client) => {
        if (!client.getDaemonIdentity()?.providerRelay) {
          return
        }
        const channel = providerRelayChannel(client)
        const result = await withTimeout(
          channel.list(LAUNCH_LIST_TIMEOUT_MS).catch(() => null),
          LAUNCH_LIST_TIMEOUT_MS,
          null
        )
        for (const info of result?.relays ?? []) {
          // A relay someone else is attached to belongs to another running app.
          if (!info.attached && info.chatKey) {
            listed.set(info.chatKey, { channel, info })
          }
        }
      })
    )
  })()
  return listing
}

/** Chats whose agent is still running under the daemon; restart offers must leave these alone. */
export function liveProviderRelayChats(): ReadonlySet<string> {
  return new Set([...listed].filter(([, relay]) => relay.info.exit === null).map(([key]) => key))
}

/** The pid of the chat's agent the daemon kept running, until this app reattaches it. */
export function keptRunningProviderRelayPid(chatKey: string): number | null {
  const relay = listed.get(chatKey)
  return relay && relay.info.exit === null ? relay.info.pid : null
}

/** Ended relays found at launch are dropped once their chat cold-resumes. */
export function dropListedProviderRelay(chatKey: string): void {
  const relay = listed.get(chatKey)
  listed.delete(chatKey)
  if (relay) {
    void relay.channel.close(relay.info.relayId).catch(() => {})
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

/** The chat's agent kept from before this app started, attached from its last acked line. */
async function reattachListed(launch: ProviderRelayLaunch): Promise<RelayedProviderProcess | null> {
  const relay = listed.get(launch.chatKey)
  if (!relay) {
    return null
  }
  listed.delete(launch.chatKey)
  const { channel, info } = relay
  if (info.exit !== null || info.pid === null || !(await connected(channel.client))) {
    void channel.close(info.relayId).catch(() => {})
    return null
  }
  const child = relayedChild(channel, info.relayId, info.pid, launch, launch.passWhileHeld)
  try {
    await child.start(info.ackedSeq)
  } catch {
    return null
  }
  if (child.exited) {
    return null
  }
  track(launch.chatKey, child, launch.markers)
  return { managed: relayedManagedProcess(child), child, reattached: true }
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
  await listing
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

/** True when quit should hand this chat's agent to the daemon rather than stop it. */
export function hasAttachedProviderRelay(chatKey: string): boolean {
  const child = attached.get(chatKey)
  return child !== undefined && child.exited === null && !child.handedOff
}

/** Hands the chat's agent to the daemon; it keeps working and the next launch reattaches it. */
export async function detachProviderRelayForQuit(
  chatKey: string,
  working: boolean
): Promise<boolean> {
  const child = attached.get(chatKey)
  const markers = child ? markersFor.get(child) : undefined
  if (!child || !markers || child.exited !== null) {
    return false
  }
  attached.delete(chatKey)
  // A failed detach request still hands the agent off: the closing stream detaches it daemon-side.
  await child.detach(policyFor(markers, working)).catch(() => {})
  return true
}
