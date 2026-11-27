import type { DaemonClient } from '../daemon/transport/client/daemon-client'
import type { ProviderRelayInfo } from '../daemon/protocol/daemon-provider-relay-protocol'
import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import { providerRelayChannel, type ProviderRelayChannel } from './provider-relay-channel'
import { readFile } from 'node:fs/promises'
import { spawnTokenFromEnvironBlock } from '../runtime/agent-session/ownership/agent-session-spawn-token-readback'
import {
  forgetProviderRelayRunVerdict,
  providerRelayRunAskUnfenced,
  providerRelayRunUnknown
} from './provider-relay-run-verdicts'
export {
  beginProviderRelayRunAsk,
  forgetIdleProviderRelayRunVerdict,
  forgetProviderRelayRunVerdict,
  noteProviderRelayRunVerdict,
  providerRelayRunAskAwaitsProof,
  providerRelayRunAskCurrent,
  providerRelayRunUnknown
} from './provider-relay-run-verdicts'

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
/** `ask`: the liveness ask that found it; an ask fenced off by a close, deletion or new run writes nothing. */
export async function placeKeptProviderRelay(
  chatKey: string,
  relay: KeptProviderRelay,
  ask: number
) {
  const placed = () => listed.get(chatKey)?.info.relayId === relay.info.relayId
  if (!providerRelayRunAskUnfenced(chatKey, ask) || placed()) {
    return
  }
  // The row and its token are published together, so no ask ever sees a row whose token is pending.
  const token = await sharedTokenRead(chatKey, relay.info)
  if (!providerRelayRunAskUnfenced(chatKey, ask) || placed()) {
    return
  }
  listed.set(chatKey, relay)
  if (token) {
    spawnTokens.set(chatKey, token)
  } else {
    spawnTokens.delete(chatKey)
  }
}

/** One token read in flight per chat and relay, however many asks overlap it. */
const tokenReads = new Map<string, { relayId: string; read: Promise<string | null> }>()

function sharedTokenRead(chatKey: string, info: ProviderRelayInfo): Promise<string | null> {
  const inFlight = tokenReads.get(chatKey)
  if (inFlight?.relayId === info.relayId) {
    return inFlight.read
  }
  const entry = {
    relayId: info.relayId,
    read: info.pid !== null && info.exit === null ? readSpawnToken(info.pid) : Promise.resolve(null)
  }
  tokenReads.set(chatKey, entry)
  void entry.read.finally(() => {
    if (tokenReads.get(chatKey) === entry) {
      tokenReads.delete(chatKey)
    }
  })
  return entry.read
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
  /** Only an answer is reused; an unanswered listing is asked again by the next caller. */
  answered: boolean
  listing: Promise<ReadonlyMap<string, ProviderRelayInfo> | null>
  /** The answer's cleanup, run once by the first ask that acts on it; an observer never runs it. */
  kept: Promise<void> | null
  /** Its cleanup is still running: every ask joins this listing until it ends, fresh or not. */
  cleaning: boolean
  /** The answer once it arrived, for reads that need no ask. */
  answer: ReadonlyMap<string, ProviderRelayInfo> | null
  keep: () => Promise<void>
}
/** By daemon start; bounded by the daemons this app has talked to. */
const instanceListings = new Map<string, InstanceListing>()

/**
 * The relays one daemon start holds, by relay id; null when it didn't answer. `fresh` asks again
 * unless a listing is in flight (a send or a failed attach must not reuse an answer); otherwise an
 * answer settled within 2 s answers. An unanswered one is never reused. `observe` only reads: it
 * neither ends relays nor records anything.
 */
export async function listProviderRelayInstance(
  client: DaemonClient,
  instance: string,
  fresh = false,
  observe = false
): Promise<ReadonlyMap<string, ProviderRelayInfo> | null> {
  const entry = instanceListing(client, instance, fresh)
  const listing = await entry.listing
  if (listing && !observe) {
    if (!entry.kept) {
      entry.cleaning = true
      entry.kept = entry.keep().finally(() => {
        entry.cleaning = false
        entry.settledAt = Date.now()
      })
    }
    await entry.kept
  }
  return listing
}

function instanceListing(client: DaemonClient, instance: string, fresh: boolean): InstanceListing {
  const cached = instanceListings.get(instance)
  if (
    cached &&
    (cached.settledAt === Number.POSITIVE_INFINITY ||
      cached.cleaning ||
      (!fresh && cached.answered && Date.now() - cached.settledAt < INSTANCE_LISTING_FRESH_MS))
  ) {
    return cached
  }
  const channel = providerRelayChannel(client)
  const entry: InstanceListing = {
    settledAt: Number.POSITIVE_INFINITY,
    answered: false,
    listing: Promise.resolve(null),
    kept: null,
    cleaning: false,
    answer: null,
    keep: async () => {}
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
      entry.keep = () => keep(channel, result.relays)
      entry.answered = true
      entry.answer = new Map(result.relays.map((info) => [info.relayId, info]))
      return entry.answer
    })
    .finally(() => {
      entry.settledAt = Date.now()
    })
  // Only a settled answer within its 2 s is ever reused: older ones (a restarted daemon's) go.
  for (const [key, old] of instanceListings) {
    if (!old.cleaning && Date.now() - old.settledAt >= INSTANCE_LISTING_FRESH_MS) {
      instanceListings.delete(key)
    }
  }
  instanceListings.set(instance, entry)
  return entry
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

/** Its daemon start's latest answer (asked by anyone) says the daemon idle-stopped this relay. */
export function providerRelayListedIdleStopped(instance: string, relayId: string): boolean {
  return instanceListings.get(instance)?.answer?.get(relayId)?.exit?.idleStopped === true
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
  if (!keepUnread) {
    forgetProviderRelayRunVerdict(chatKey)
  }
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
    providerRelayRunUnknown(chatKey) ||
    keptRunningProviderRelayPid(chatKey) !== null
  )
}
