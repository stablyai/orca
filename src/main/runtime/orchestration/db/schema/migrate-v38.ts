import type { OrchestrationDb } from '../orchestration-db'

/**
 * Settling a Dispatch through the task-status path never closed its pending question threads, so
 * a completed pre-v3 row kept an `input` attention category forever. Nothing can answer a question
 * on a settled Dispatch (`answerQuestion` refuses closed threads and the Dispatch is inactive), so
 * closing them is the only reading that matches the row.
 */
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
