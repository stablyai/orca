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

/** Relays the daemons kept for chats while no app was attached, found once per launch. */
const listed = new Map<string, KeptProviderRelay>()
let listing: Promise<void> | null = null
/** After a daemon didn't answer, callers use what is known until this; then one asks again. */
let retryAt = 0
const RETRY_AFTER_MS = 30_000

/** The kept agent's own spawn token, so its reattach records the identity the process carries. */
const spawnTokens = new Map<string, string>()

/** Agent integrations this build can reattach; a relay of any other is ended at launch. */
const reattachableAgents = new Set<string>()

export function registerReattachableProviderRelayAgent(agent: string): void {
  reattachableAgents.add(agent)
}

/** Still running, or ended with output the chat hasn't taken in yet: either way the chat reattaches. */
export function keptProviderRelayOutstanding(info: ProviderRelayInfo): boolean {
  return info.exit === null || info.nextSeq - 1 > info.ackedSeq
}

/**
 * A relay someone else is attached to belongs to another running app. One this build can't
 * reattach (left by a newer build) is ended, so its chat recovers as today and never gets a second
 * agent beside the kept one.
 */
async function keep(channel: ProviderRelayChannel, relays: readonly ProviderRelayInfo[]) {
  for (const info of relays) {
    if (!info.attached && info.agent !== null && !reattachableAgents.has(info.agent)) {
      await channel.close(info.relayId).catch(() => {})
      continue
    }
    if (!info.attached && info.chatKey) {
      listed.set(info.chatKey, { channel, info })
      const token = info.pid !== null && info.exit === null ? await readSpawnToken(info.pid) : null
      if (token) {
        spawnTokens.set(info.chatKey, token)
      }
    }
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

async function listOne(client: DaemonClient): Promise<boolean> {
  if (!client.getDaemonIdentity()?.providerRelay) {
    return true
  }
  const channel = providerRelayChannel(client)
  const result = await withTimeout(
    channel.list(LIST_TIMEOUT_MS).catch(() => null),
    LIST_TIMEOUT_MS,
    null
  )
  if (result) {
    await keep(channel, result.relays)
  }
  return result !== null
}

/**
 * One `relayList` per daemon. A daemon that didn't answer is asked again by the next caller, so a
 * slow start never reads as "no kept agents" for good.
 */
export function listKeptProviderRelays(clients: () => Promise<DaemonClient[]>): Promise<void> {
  if (!listing && Date.now() < retryAt) {
    return Promise.resolve()
  }
  listing ??= (async () => {
    const all = await withTimeout(
      clients().catch(() => null),
      DAEMON_WAIT_MS,
      null
    )
    const answered = all ? await Promise.all(all.map(listOne)) : [false]
    if (answered.includes(false)) {
      listing = null
      retryAt = Date.now() + RETRY_AFTER_MS
    }
  })()
  return listing
}

export function keptProviderRelay(chatKey: string): KeptProviderRelay | undefined {
  return listed.get(chatKey)
}

/** Chats whose agent the daemon still holds for them; restart offers must leave these alone. */
export function liveKeptProviderRelayChats(): ReadonlySet<string> {
  const live = new Set<string>()
  for (const [chatKey, relay] of listed) {
    if (keptProviderRelayOutstanding(relay.info)) {
      live.add(chatKey)
    }
  }
  return live
}

export function forgetKeptProviderRelay(chatKey: string, relay: KeptProviderRelay): void {
  if (listed.get(chatKey) === relay) {
    listed.delete(chatKey)
  }
}

/** Asks the relay's daemon again: still running (keep it), or proven ended or gone. */
export async function recheckKeptProviderRelay(
  chatKey: string,
  relay: KeptProviderRelay
): Promise<'live' | 'gone' | 'unknown'> {
  const result = await withTimeout(
    relay.channel.list(LIST_TIMEOUT_MS).catch(() => null),
    LIST_TIMEOUT_MS,
    null
  )
  if (!result) {
    // An unreachable daemon with a dead agent is as gone as a daemon that says so.
    if (relay.info.pid === null || !processProvenGone(relay.info.pid)) {
      return 'unknown'
    }
    forgetKeptProviderRelay(chatKey, relay)
    return 'gone'
  }
  const now = result.relays.find((info) => info.relayId === relay.info.relayId)
  if (now && now.exit === null) {
    return 'live'
  }
  forgetKeptProviderRelay(chatKey, relay)
  return 'gone'
}

/** Only ESRCH proves absence; "can't tell" keeps the agent. */
function processProvenGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
  }
}

/** The pid of the chat's agent the daemon kept running, until this app reattaches it. */
export function keptRunningProviderRelayPid(chatKey: string): number | null {
  const relay = keptProviderRelay(chatKey)
  return relay && keptProviderRelayOutstanding(relay.info) ? relay.info.pid : null
}

/** Ended relays found at launch are dropped once their chat cold-resumes. */
export function dropListedProviderRelay(chatKey: string): void {
  const relay = keptProviderRelay(chatKey)
  if (relay) {
    forgetKeptProviderRelay(chatKey, relay)
    void relay.channel.close(relay.info.relayId).catch(() => {})
  }
}

/** Chats whose agent this app reattached from the last run; it stays true after that agent ends. */
const reattachedFromLastRun = new Set<string>()

export function noteProviderRelayReattachedFromLastRun(chatKey: string): void {
  reattachedFromLastRun.add(chatKey)
}

/**
 * The last run's writer for this chat was kept, not stopped by its quit: still held by the daemon,
 * or reattached by this app (even if a Stop has ended it since). Its turns ended here, never by quit.
 */
export function providerRelayKeptFromLastRun(chatKey: string): boolean {
  return reattachedFromLastRun.has(chatKey) || keptRunningProviderRelayPid(chatKey) !== null
}
