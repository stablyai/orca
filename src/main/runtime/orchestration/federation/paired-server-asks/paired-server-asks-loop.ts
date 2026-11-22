// The pull loop's part in taking asks from a paired server's agents: it names this computer on its
// pulls, notes the pairing the server answered under, and, once a batch is acknowledged, admits what
// was allowed and hands back what is owed. Nothing here is timed.
import { z } from 'zod'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { OrchestrationEnvironmentTransport } from '../environment-transport'
import { onPeerMailQueued } from '../peer-mail/peer-mail-waiters'
import {
  followServerRoute,
  noteAnnounced,
  owesAnnouncement,
  pairedServerAsksFor,
  type PairedServerAsks
} from './paired-server-asks-pull'
import { admitPairedServerAsks } from './paired-server-ask-admission'
import { flushPairedServerReturns } from './paired-server-ask-returns'
import {
  importPairedServerItem,
  PAIRED_SERVER_ITEM_KINDS,
  type PulledItem
} from './paired-server-ask-import'

const Answered = z.object({ clientAsks: z.object({ seenAs: z.string() }).optional() })

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

/** Read once per loop run; a server that can't be read now pulls as before until the next run. */
export async function beginPairedServerAsks(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  environmentId: string,
  transport: OrchestrationEnvironmentTransport | null
): Promise<PairedServerAsks | null> {
  const asks = await pairedServerAsksFor(runtime, db, environmentId).catch(() => null)
  if (!asks) {
    return null
  }
  const paired = await pairedEnvironments(transport)
  if (paired) {
    followServerRoute(db, asks, paired)
  }
  activeOf(runtime).set(environmentId, asks)
  if (!watchedDatabases.has(db.db)) {
    watchedDatabases.add(db.db)
    // A reply or notice queued here goes back now, not after the pull's long wait.
    onPeerMailQueued(db.db, () => {
      for (const active of activeOf(runtime).values()) {
        void flushPairedServerReturns(runtime, active)
      }
    })
  }
  return asks
}

export function endPairedServerAsks(
  runtime: OrcaRuntimeService,
  asks: PairedServerAsks | null | undefined
): void {
  if (asks && activeOf(runtime).get(asks.environmentId) === asks) {
    activeOf(runtime).delete(asks.environmentId)
  }
}

export function pairedServerPullParams(asks: PairedServerAsks | null | undefined): {
  clientAsks?: PairedServerAsks['wire']
} {
  return asks ? { clientAsks: asks.wire } : {}
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
    void admitPairedServerAsks(runtime, asks.environmentId, asks.pairing)
    void flushPairedServerReturns(runtime, asks)
  }
}

/** An approved card is admitted now by the loop that knows the server's pairing. */
export function admitPairedServerAsksNow(runtime: OrcaRuntimeService, environmentId: string): void {
  const asks = activeOf(runtime).get(environmentId)
  if (asks) {
    void admitPairedServerAsks(runtime, environmentId, asks.pairing)
  }
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
    const asks = await pairedServerAsksFor(runtime, db, environmentId).catch(() => null)
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

/** Announces at once, and again for each pairing that is verified later. */
export function watchPairedServers(
  runtime: OrcaRuntimeService,
  transport: OrchestrationEnvironmentTransport,
  pullOnce: (environmentId: string) => void
): void {
  void announcePairedServers(runtime, transport, pullOnce)
  transport.onEnvironmentVerified?.(
    (environmentId) => void announcePairedServers(runtime, transport, pullOnce, environmentId)
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
