import type { OrchestrationDb } from '../orchestration-db'

/** Close unanswerable questions on settled Dispatches to clear stale input attention. */
export function migrateV38(this: OrchestrationDb, current: number): void {
  if (current >= 38) {
    return
  }
  this.db.exec(
    `UPDATE question_threads
        SET status = 'closed', closed_at = datetime('now')
      WHERE status = 'pending'
        AND dispatch_id IN (
          SELECT id FROM dispatch_contexts WHERE status NOT IN ('pending', 'dispatched')
        )`
  )
}
