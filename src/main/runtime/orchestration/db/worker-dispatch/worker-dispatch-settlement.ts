import type Database from '../../../../sqlite/sync-database'
import {
  beginLifecycleWriteTransaction,
  commitLifecycleWriteTransaction,
  rollbackLifecycleWriteTransaction,
  transitionLifecycleWithDb
} from '../lifecycle-transition'

/** Settles assignment bookkeeping without claiming process exit or releasing a terminal. */
export function settleWorkerForCompletedDispatch(db: Database.Database, dispatchId: string): void {
  const worker = db
    .prepare(
      `SELECT wd.state FROM worker_dispatches wd
       JOIN dispatch_contexts dc ON dc.id = wd.dispatch_id
       WHERE wd.dispatch_id = ? AND dc.status IN ('completed', 'failed', 'circuit_broken')
         AND wd.state IN ('starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown')`
    )
    .get(dispatchId)
  if (worker === undefined) {
    return
  }
  if (
    typeof worker !== 'object' ||
    worker === null ||
    !('state' in worker) ||
    typeof worker.state !== 'string'
  ) {
    throw new Error('Invalid worker settlement row')
  }
  transitionLifecycleWithDb(db, {
    entity: 'worker',
    id: dispatchId,
    from: worker.state,
    to: 'abandoned',
    projection: { stage: 'assignment_settled', updated_at: new Date().toISOString() }
  })
}

/** Repairs stale assignments on open without scanning finished worker history. */
export function reconcileSettledWorkerDispatches(db: Database.Database): void {
  const candidates = db.prepare(
    `SELECT wd.dispatch_id FROM worker_dispatches wd
     WHERE wd.state IN ('starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown')
       AND EXISTS (
         SELECT 1 FROM dispatch_contexts dc
         WHERE dc.id = wd.dispatch_id
           AND dc.status IN ('completed', 'failed', 'circuit_broken')
       )`
  )
  if (candidates.get() === undefined) {
    return
  }
  const transaction = beginLifecycleWriteTransaction(db, 'reconcile_settled_workers')
  try {
    // Re-read after taking the writer lock; the preflight is only a no-op shortcut.
    const rows = candidates.all()
    for (const row of rows) {
      if (
        typeof row !== 'object' ||
        row === null ||
        !('dispatch_id' in row) ||
        typeof row.dispatch_id !== 'string'
      ) {
        throw new Error('Invalid worker settlement identity')
      }
      settleWorkerForCompletedDispatch(db, row.dispatch_id)
    }
    commitLifecycleWriteTransaction(db, transaction)
  } catch (error) {
    rollbackLifecycleWriteTransaction(db, transaction)
    throw error
  }
}
