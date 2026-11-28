// The pull loop's part in taking asks from a paired server's agents: it names this computer on its
// pulls, notes the pairing the server answered under, and, once a batch is acknowledged, admits what
// was allowed and hands back what is owed. Nothing here is timed.
import { z } from 'zod'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type {
  OrchestrationEnvironmentTransport,
  OrchestrationWorkerServer
} from '../environment-transport'
import { peerMailPairing } from '../peer-mail/peer-mail-delivery'
import {
  listAllowedBotsOfServer,
  pairedServerAsksWanted
} from '../../db/federation/paired-server-asks-store'
import { PAIRED_CLIENT_BOTS_MAX } from '../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import type { Bot } from '../../../../../shared/bot-types'
import { onPeerMailQueued } from '../peer-mail/peer-mail-waiters'
import {
  followServerRoute,
  knownServerAsksSupport,
  noteAnnounced,
  owesAnnouncement,
  pairedServerAsksFor,
  readServerAsksSupport,
  type PairedServerAsks,
  type ServerAsksSupport
} from './paired-server-asks-pull'
import { admitPairedServerAsks } from './paired-server-ask-admission'
import { flushPairedServerReturns } from './paired-server-ask-returns'
import {
  importPairedServerItem,
  PAIRED_SERVER_ITEM_KINDS,
  type PulledItem
} from './paired-server-ask-import'
import { lazyZodSchema } from '../../../../../shared/schema/lazy-zod-schema'

const Answered = lazyZodSchema(() =>
  z.object({ clientAsks: z.object({ seenAs: z.string() }).optional() })
)

// The servers each runtime's loops take asks from now, so a queued reply knows where to go.
const activeByRuntime = new WeakMap<object, Map<string, PairedServerAsks>>()
const watchedDatabases = new WeakSet<object>()

function activeOf(runtime: OrcaRuntimeService): Map<string, PairedServerAsks> {
  const active = activeByRuntime.get(runtime) ?? new Map<string, PairedServerAsks>()
  activeByRuntime.set(runtime, active)
  return active
}

async function pairedEnvironments(
  transport: OrchestrationEnvironmentTransport | null
): Promise<ReadonlySet<string> | null> {
  const listed = await transport?.list?.().catch(() => undefined)
  return listed ? new Set(listed.map((entry) => entry.environmentId)) : null
}

/** The part of a pull loop that names it to a server that sends this computer asks. */
export type PairedServerAsksHolder = {
  db: OrchestrationDb
  forceOnce?: boolean
  asks?: PairedServerAsks | null
  /** The pairing and server answer the current asks were built from. */
  asksFrom?: string
  /** Read the server's status afresh before the next pull: it recovered, or an announce came. */
  asksStale?: boolean
}

function supportKey(pairing: string, support: ServerAsksSupport | undefined): string | undefined {
  return support === undefined ? undefined : `${pairing}\0${support?.serverInstallationId ?? ''}`
}

/** Before each pull: the loop reads the server again when it never could, it recovered, an announce
 *  came, or the pairing or the server's answer changed; otherwise it keeps its session. A loop with
 *  no ask to pull for doesn't wait on a first read: the next pull uses it. */
export async function refreshPairedServerAsks(
  runtime: OrcaRuntimeService,
  holder: PairedServerAsksHolder,
  server: OrchestrationWorkerServer,
  transport: OrchestrationEnvironmentTransport | null
): Promise<void> {
  const pairing = peerMailPairing(server)
  const known = supportKey(pairing, knownServerAsksSupport(runtime, server))
  if (!holder.asksStale && known !== undefined && known === holder.asksFrom) {
    return
  }
  if (holder.asks && holder.asks.pairing !== pairing) {
    endPairedServerAsks(runtime, holder.asks)
    holder.asks = null
  }
  if (
    known === undefined &&
    !holder.asksStale &&
    !holder.forceOnce &&
    !pairedServerAsksWanted(holder.db, server.environmentId)
  ) {
    void readServerAsksSupport(runtime, server).catch(() => undefined)
    return
  }
  const next = await pairedServerAsksFor(runtime, holder.db, server.environmentId, {
    server,
    fresh: holder.asksStale
  }).catch(() => undefined)
  if (next === undefined) {
    // Unread: the next pull tries again.
    return
  }
  holder.asksStale = false
  holder.asksFrom = supportKey(pairing, knownServerAsksSupport(runtime, server))
  const same =
    next && holder.asks?.pairing === next.pairing && holder.asks.serverKey === next.serverKey
  if (same) {
    return
  }
  endPairedServerAsks(runtime, holder.asks)
  holder.asks = next
  if (next) {
    await beginPairedServerAsks(runtime, holder.db, next, transport)
  }
}

async function beginPairedServerAsks(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  asks: PairedServerAsks,
  transport: OrchestrationEnvironmentTransport | null
): Promise<void> {
  activeOf(runtime).set(asks.environmentId, asks)
  const paired = await pairedEnvironments(transport)
  if (paired) {
    followServerRoute(db, asks, paired)
  }
  if (!watchedDatabases.has(db.db)) {
    watchedDatabases.add(db.db)
    // A reply or notice queued here goes back now, not after the pull's long wait.
    onPeerMailQueued(db.db, () => {
      for (const active of activeOf(runtime).values()) {
        void flushPairedServerReturns(runtime, active)
      }
    })
  }
}

/** The loop stops taking asks under this session: the server hears it, so sends there fail as
 *  offline at once rather than when its pull times out. */
export function endPairedServerAsks(
  runtime: OrcaRuntimeService,
  asks: PairedServerAsks | null | undefined
): void {
  if (asks && activeOf(runtime).get(asks.environmentId) === asks) {
    activeOf(runtime).delete(asks.environmentId)
    void leavePairedServer(runtime, asks)
  }
}

/** What a pull names this computer with; on each pull, read afresh, the agents here a person always
 *  lets this server ask (none paused or removed, and none while bots are off here), so a change reaches the server by the next pull. */
export function pairedServerPullParams(
  runtime: { bots: { enabled(): boolean; list(): readonly Pick<Bot, 'id' | 'name' | 'paused'>[] } },
  db: OrchestrationDb,
  asks: PairedServerAsks | null | undefined
): {
  clientAsks?: PairedServerAsks['wire']
} {
  if (!asks) {
    return {}
  }
  const allowed = new Set(listAllowedBotsOfServer(db, asks.serverKey))
  const askable =
    // Bots off here: none takes an ask, so none is named.
    allowed.size === 0 || !runtime.bots.enabled()
      ? []
      : runtime.bots.list().filter((bot) => allowed.has(bot.id) && !bot.paused)
  const bots = askable
    .slice(0, PAIRED_CLIENT_BOTS_MAX)
    .map((bot) => ({ id: bot.id, name: bot.name }))
  // Past the cap the server is told some go unnamed, so it never reads the list as all of them.
  const more = askable.length > bots.length ? { moreBots: true } : {}
  return { clientAsks: { ...asks.wire, bots, ...more } }
}

/** The server answered: a pairing not announced yet is announced now. */
export function notePairedServerAnswer(
  db: OrchestrationDb,
  asks: PairedServerAsks | null | undefined,
  response: unknown
): void {
  const seenAs = Answered.safeParse(response).data?.clientAsks?.seenAs
  if (asks && seenAs && (owesAnnouncement(db, asks) || asks.wire.previousPairing)) {
    noteAnnounced(db, asks, seenAs)
  }
}

export function afterPairedServerPull(
  runtime: OrcaRuntimeService,
  asks: PairedServerAsks | null | undefined
): void {
  if (asks) {
    void admitPairedServerAsks(runtime, asks.environmentId)
    void flushPairedServerReturns(runtime, asks)
  }
}

/** An approved card is admitted now, connected or not. */
export function admitPairedServerAsksNow(runtime: OrcaRuntimeService, environmentId: string): void {
  void admitPairedServerAsks(runtime, environmentId)
}

/** At startup, and when a pairing is verified: a capable server this computer hasn't announced
 *  itself to under its current pairing gets one pull, so the server can end the pairing it replaced. */
export async function announcePairedServers(
  runtime: OrcaRuntimeService,
  transport: OrchestrationEnvironmentTransport | null,
  pullOnce: (environmentId: string) => void,
  only?: string
): Promise<void> {
  const paired = await pairedEnvironments(transport)
  const db = runtime.getOrchestrationDb()
  for (const environmentId of only ? [only] : [...(paired ?? [])]) {
    // A server that just turned verified may have restarted on a new version: read it again.
    const asks = await pairedServerAsksFor(runtime, db, environmentId, { fresh: !!only }).catch(
      () => null
    )
    if (!asks) {
      continue
    }
    if (paired) {
      followServerRoute(db, asks, paired)
    }
    if (owesAnnouncement(db, asks)) {
      pullOnce(environmentId)
    }
  }
}

/** Announces at once, and again for each pairing that is verified later, until unsubscribed. */
export function watchPairedServers(
  runtime: OrcaRuntimeService,
  transport: OrchestrationEnvironmentTransport,
  pullOnce: (environmentId: string) => void
): () => void {
  // Approved before a restart: admitted now, not at the server's next answer.
  void admitPairedServerAsks(runtime)
  void announcePairedServers(runtime, transport, pullOnce)
  return (
    transport.onEnvironmentVerified?.(
      (environmentId) => void announcePairedServers(runtime, transport, pullOnce, environmentId)
    ) ?? (() => {})
  )
}

/** Imports an item a server that sends this computer asks queued for it; false for any other item. */
export async function importAsk(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  asks: PairedServerAsks | null | undefined,
  item: PulledItem
): Promise<boolean> {
  if (!asks || !PAIRED_SERVER_ITEM_KINDS.has(item.kind ?? '')) {
    return false
  }
  await importPairedServerItem(runtime, db, asks, item)
  return true
}

const LEAVE_TIMEOUT_MS = 15_000

/** The loop taking asks from that server now, or every one when no server is named. */
export function activePairedServerAsks(runtime: OrcaRuntimeService): PairedServerAsks[]
export function activePairedServerAsks(
  runtime: OrcaRuntimeService,
  environmentId: string
): PairedServerAsks | undefined
export function activePairedServerAsks(
  runtime: OrcaRuntimeService,
  environmentId?: string
): PairedServerAsks[] | PairedServerAsks | undefined {
  const active = activeOf(runtime)
  return environmentId === undefined ? [...active.values()] : active.get(environmentId)
}

/** Tells the server this computer stops listening now, so sends there fail as offline at once. */
export async function leavePairedServer(
  runtime: OrcaRuntimeService,
  asks: PairedServerAsks
): Promise<void> {
  await runtime
    .callOrchestrationWorkerServer(
      asks.environmentId,
      'orchestration.peerMailPull',
      { waitMs: 0, clientAsks: { ...asks.wire, leave: true } },
      LEAVE_TIMEOUT_MS
    )
    .catch(() => undefined)
}
