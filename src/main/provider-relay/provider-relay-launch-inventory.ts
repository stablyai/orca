import type { DaemonClient } from '../daemon/transport/client/daemon-client'
import type { ProviderRelayInfo } from '../daemon/protocol/daemon-provider-relay-protocol'
import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import { providerRelayChannel, type ProviderRelayChannel } from './provider-relay-channel'
import { readFile } from 'node:fs/promises'
import { spawnTokenFromEnvironBlock } from '../runtime/agent-session/ownership/agent-session-spawn-token-readback'

const LIST_TIMEOUT_MS = 3_000
/** Launch waits this long for the daemon before treating its relays as unknown (not absent). */
const DAEMON_WAIT_MS = 10_000

export type KeptProviderRelay = { channel: ProviderRelayChannel; info: ProviderRelayInfo }

/**
 * The relay this app will reattach for each chat: placed only once the chat's own run placement
 * named it and its daemon start listed it (or this app handed it back), never from another daemon.
 */
const listed = new Map<string, KeptProviderRelay>()
let listing: Promise<void> | null = null
let firstListing: Promise<void> | null = null
let launchListed = false
/** After a daemon didn't answer the launch pass, it is asked again no sooner than this. */
let retryAt = 0
const RETRY_AFTER_MS = 30_000

/** Chats whose detached agent the daemon idle-stopped: it stops only work that had ended, so
 *  nothing of theirs was cut and restart offers leave them alone. */
const idleStoppedThisRun = new Set<string>()

/** The kept agent's own spawn token, so its reattach records the identity the process carries. */
const spawnTokens = new Map<string, string>()

/** Agent integrations this build can reattach; a relay of any other is ended at launch. */
const reattachableAgents = new Set<string>()

/** Integrations whose open works on an ended agent: handed one once, to show its unread output. */
const opensEndedAgents = new Set<string>()

/** Chat providers (record `provider`) whose agent can be kept: only their chats wait on a listing. */
const keepableProviders = new Set<string>()

export function registerReattachableProviderRelayAgent(
  agent: string,
  options: { opensEnded?: boolean; provider?: string } = {}
): void {
  reattachableAgents.add(agent)
  if (options.provider) {
    keepableProviders.add(options.provider)
  }
  if (options.opensEnded) {
    opensEndedAgents.add(agent)
  }
}

/** Output the agent printed that no app took. */
export function keptProviderRelayUnread(info: ProviderRelayInfo): boolean {
  return info.nextSeq - 1 > info.ackedSeq
}

export function providerRelayAgentOpensEnded(agent: string | null): boolean {
  return agent !== null && opensEndedAgents.has(agent)
}

/**
 * Its agent still runs, or ended with unread output its integration can open an ended agent to
 * show. Any other ended agent can't answer a reattach's open: its chat recovers as ended.
 */
export function keptProviderRelayOutstanding(info: ProviderRelayInfo): boolean {
  return (
    info.exit === null ||
    (providerRelayAgentOpensEnded(info.agent) && keptProviderRelayUnread(info))
  )
}

/** Outstanding, with a process to attach to. */
export function keptProviderRelayAttachable(
  info: ProviderRelayInfo
): info is ProviderRelayInfo & { pid: number } {
  return info.pid !== null && keptProviderRelayOutstanding(info)
}

/**
 * A relay someone else is attached to belongs to another running app. One this build can't
 * reattach (left by a newer build) is ended, so its chat recovers as today and never gets a second
 * agent beside the kept one.
 */
async function keep(channel: ProviderRelayChannel, relays: readonly ProviderRelayInfo[]) {
  for (const info of relays) {
    // A daemon from before agents were named lists none (undefined): its relays stay listed.
    if (!info.attached && typeof info.agent === 'string' && !reattachableAgents.has(info.agent)) {
      await channel.close(info.relayId).catch(() => {})
      continue
    }
    if (!info.attached && info.chatKey && info.exit?.idleStopped) {
      idleStoppedThisRun.add(info.chatKey)
    }
  }
}

/** The chat's run placement named this relay and its daemon start listed it: reattach it. */
export async function placeKeptProviderRelay(chatKey: string, relay: KeptProviderRelay) {
  if (listed.get(chatKey)?.info.relayId === relay.info.relayId) {
    return
  }
  listed.set(chatKey, relay)
  const { pid, exit } = relay.info
  const token = pid !== null && exit === null ? await readSpawnToken(pid) : null
  if (token) {
    spawnTokens.set(chatKey, token)
  } else {
    spawnTokens.delete(chatKey)
  }
}

async function readSpawnToken(pid: number): Promise<string | null> {
  if (process.platform !== 'linux') {
    return null
  }
  return readFile(`/proc/${pid}/environ`, 'utf-8').then(spawnTokenFromEnvironBlock, () => null)
}

/** Linux only (where identity probes read it back); elsewhere the start time proves identity. */
export function keptProviderRelaySpawnToken(chatKey: string): string | null {
  return listed.has(chatKey) ? (spawnTokens.get(chatKey) ?? null) : null
}

/** One daemon start's listing, shared by every caller and fresh this long after it settles. */
const INSTANCE_LISTING_FRESH_MS = 2_000
type InstanceListing = {
  settledAt: number
  listing: Promise<ReadonlyMap<string, ProviderRelayInfo> | null>
}
/** By daemon start; bounded by the daemons this app has talked to. */
const instanceListings = new Map<string, InstanceListing>()

/**
 * The relays one daemon start holds, by relay id; null when it didn't answer. `fresh` asks again
 * unless a listing is in flight (a send, a failed attach, or an earlier timeout must not reuse an
 * answer); otherwise one settled within 2 s answers.
 */
export function listProviderRelayInstance(
  client: DaemonClient,
  instance: string,
  fresh = false
): Promise<ReadonlyMap<string, ProviderRelayInfo> | null> {
  const cached = instanceListings.get(instance)
  if (
    cached &&
    (cached.settledAt === Number.POSITIVE_INFINITY ||
      (!fresh && Date.now() - cached.settledAt < INSTANCE_LISTING_FRESH_MS))
  ) {
    return cached.listing
  }
  const channel = providerRelayChannel(client)
  const entry: InstanceListing = {
    settledAt: Number.POSITIVE_INFINITY,
    listing: Promise.resolve(null)
  }
  entry.listing = withTimeout(
    channel.list(LIST_TIMEOUT_MS).catch(() => null),
    LIST_TIMEOUT_MS,
    null
  )
    .then(async (result) => {
      // A reply from another start (the client reconnected) says nothing about this one.
      if (!result || (result.daemonInstance !== undefined && result.daemonInstance !== instance)) {
        return null
      }
      await keep(channel, result.relays)
      return new Map(result.relays.map((info) => [info.relayId, info]))
    })
    .finally(() => {
      entry.settledAt = Date.now()
    })
  instanceListings.set(instance, entry)
  return entry.listing
}

async function listOne(client: DaemonClient): Promise<boolean> {
  const identity = client.getDaemonIdentity()
  // A disconnected client's daemon is unknown, not one without relays.
  if (!identity?.providerRelay) {
    return identity !== null
  }
  return (await listProviderRelayInstance(client, identity.launchNonce)) !== null
}

/**
 * Once per launch, every daemon's relays: ends the ones this build can't reattach and notes chats
 * whose detached agent was idle-stopped. It decides no chat's liveness; only a chat's own run
 * placement and its daemon start do. A daemon that didn't answer is asked again after 30 s.
 */
export function listKeptProviderRelays(clients: () => Promise<DaemonClient[]>): Promise<void> {
  if (!listing && !launchListed && Date.now() >= retryAt) {
    listing = (async () => {
      const all = await withTimeout(
        clients().catch(() => null),
        DAEMON_WAIT_MS,
        null
      )
      const answered = all ? await Promise.all(all.map(listOne)) : [false]
      if (answered.includes(false)) {
        retryAt = Date.now() + RETRY_AFTER_MS
      } else {
        launchListed = true
      }
      listing = null
    })()
    firstListing ??= listing
  }
  return firstListing ?? Promise.resolve()
}

/** Only a local chat of a keepable provider that had an agent at its last run can have one kept. */
export function providerRelayMayKeep(provider: string, ownerOnLocalHost: boolean): boolean {
  return ownerOnLocalHost && process.platform !== 'win32' && keepableProviders.has(provider)
}

export function providerRelayChatsIdleStoppedThisRun(): ReadonlySet<string> {
  return idleStoppedThisRun
}

export function keptProviderRelay(chatKey: string): KeptProviderRelay | undefined {
  return listed.get(chatKey)
}

export function rememberKeptProviderRelay(chatKey: string, relay: KeptProviderRelay): void {
  listed.set(chatKey, relay)
}

/** The chat's run isn't kept (or isn't relayed): no relay of another daemon or run is reattached. */
export function forgetListedProviderRelayChat(chatKey: string): void {
  listed.delete(chatKey)
  spawnTokens.delete(chatKey)
}

/** Chats whose last run's daemon start couldn't say yet; they may still run. */
const unknownRuns = new Set<string>()

export function noteProviderRelayRunVerdict(
  chatKey: string,
  verdict: 'kept' | 'gone' | 'unknown'
): void {
  if (verdict === 'unknown') {
    unknownRuns.add(chatKey)
  } else {
    unknownRuns.delete(chatKey)
  }
}

/** Its daemon start couldn't say at the last ask; the host holds the chat until it can. */
export function providerRelayRunUnknown(chatKey: string): boolean {
  return unknownRuns.has(chatKey)
}

/** The last run may still be running: listed by its daemon start, or that start can't say yet. */
export function providerRelayRunMayContinue(chatKey: string): boolean {
  return unknownRuns.has(chatKey) || keptRunningProviderRelayPid(chatKey) !== null
}

export function forgetKeptProviderRelay(chatKey: string, relay: KeptProviderRelay): void {
  if (listed.get(chatKey) === relay) {
    listed.delete(chatKey)
    spawnTokens.delete(chatKey)
  }
}

/** The pid of the chat's agent the daemon kept running, until this app reattaches it. */
export function keptRunningProviderRelayPid(chatKey: string): number | null {
  const relay = keptProviderRelay(chatKey)
  return relay && keptProviderRelayOutstanding(relay.info) ? relay.info.pid : null
}

/** Ended relays found at launch are dropped once their chat cold-resumes. */
/** `keepUnread`: output no app took stays with the daemon (it expires there); a deleted chat drops it. */
export function dropListedProviderRelay(chatKey: string, keepUnread = false): void {
  const relay = keptProviderRelay(chatKey)
  if (relay) {
    forgetKeptProviderRelay(chatKey, relay)
    if (!keepUnread || !keptProviderRelayUnread(relay.info)) {
      void relay.channel.close(relay.info.relayId).catch(() => {})
    }
  }
}

/** Chats whose agent this app reattached from the last run; it stays true after that agent ends. */
const reattachedFromLastRun = new Set<string>()

export function noteProviderRelayReattachedFromLastRun(chatKey: string): void {
  reattachedFromLastRun.add(chatKey)
}

/**
 * The last run's writer for this chat was kept, not stopped by its quit: still held by the daemon,
 * or reattached by this app (even if a Stop has ended it since), or its daemon start can't say yet.
 * Its turns ended here, never by quit.
 */
export function providerRelayKeptFromLastRun(chatKey: string): boolean {
  return (
    reattachedFromLastRun.has(chatKey) ||
    unknownRuns.has(chatKey) ||
    keptRunningProviderRelayPid(chatKey) !== null
  )
}
