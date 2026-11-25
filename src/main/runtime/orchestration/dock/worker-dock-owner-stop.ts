import type { OrchestrationDb } from '../db/orchestration-db'
import {
  isHelperStopDone,
  type WorkerStopReceipt
} from '../../../../shared/orchestration/workers/orchestration-worker-stop-receipt'

const stopping = new WeakMap<OrchestrationDb, Map<string, number>>()

/** A stop that proved its worker ended, which the dock reads as intent. Every helper must have
 *  stopped, already finished, or been kept open by the user; a starting helper is only scheduled
 *  to stop and may still fail, so it leaves the stop unconfirmed. */
export function isConfirmedWorkerStop(receipt: WorkerStopReceipt): boolean {
  return (
    receipt.state === 'stopped' &&
    !receipt.alreadySettled &&
    receipt.processAction !== 'none' &&
    !receipt.lastError &&
    !receipt.warning &&
    !receipt.helperStopError &&
    (receipt.helpers ?? []).every(isHelperStopDone)
  )
}

export function workerDockStoppingIds(
  db: OrchestrationDb
): ReadonlyMap<string, number> | undefined {
  return stopping.get(db)
}

/** Until a requested stop, its helpers and its record finish, the dock shows the worker as stopping
 *  rather than as stopped unexpectedly. Memory only, so a restart mid-stop cannot leave it stuck. */
export async function holdWorkerDockStopping<T>(
  db: OrchestrationDb,
  dispatchId: string,
  stop: () => Promise<T>
): Promise<T> {
  // Read before the stop, so the release below touches no SQLite and cannot replace the stop's outcome.
  const fact = db.db
    .prepare('SELECT source, state FROM worker_dock_facts WHERE dispatch_id = ?')
    .get(dispatchId)
  const source = typeof fact?.source === 'string' ? fact.source : undefined
  // A worker that had already stopped (a crash) has nothing left to stop, so it keeps its label.
  const held = source !== undefined && fact?.state !== 'stopped'
  const counts = stopping.get(db) ?? new Map<string, number>()
  stopping.set(db, counts)
  const step = (by: number) => {
    const left = (counts.get(dispatchId) ?? 0) + by
    if (left > 0) {
      counts.set(dispatchId, left)
    } else {
      counts.delete(dispatchId)
    }
  }
  if (held) {
    step(1)
  }
  try {
    return await stop()
  } finally {
    if (held) {
      step(-1)
    }
    if (source !== undefined) {
      db.workerDockSources.invalidate(source)
      db.crewChanges.notify(new Set(['topology']))
    }
  }
}

/** A confirmed worker-stop was asked for, whoever asked, so it leaves the dock as the dock's Stop does. */
export function recordWorkerStop(
  db: OrchestrationDb,
  dispatchId: string,
  receipt: WorkerStopReceipt
): void {
  if (!isConfirmedWorkerStop(receipt)) {
    return
  }
  db.db
    .prepare(`INSERT OR IGNORE INTO worker_dock_owner_stops(request_id, source, dispatch_id, receipt, confirmed, settlement)
    SELECT 'worker_stop:' || dispatch_id || ':' || settlement, source, dispatch_id, ?, 1, settlement
    FROM worker_dock_facts WHERE dispatch_id = ? AND state = 'stopped'`)
    .run(JSON.stringify(receipt), dispatchId)
}
