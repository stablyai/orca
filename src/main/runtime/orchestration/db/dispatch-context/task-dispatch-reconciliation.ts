import type { DispatchContextRow } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'

export function getActiveDispatchForTask(
  db: OrchestrationDb,
  taskId: string
): DispatchContextRow | undefined {
  return db.db
    .prepare(
      "SELECT * FROM dispatch_contexts WHERE task_id = ? AND status IN ('pending', 'dispatched') ORDER BY rowid DESC LIMIT 1"
    )
    .get(taskId) as DispatchContextRow | undefined
}

export function reconcileTaskAfterDispatchInterruption(
  db: OrchestrationDb,
  taskId: string,
  dispatchId: string
): void {
  db.db
    .prepare(
      `UPDATE tasks
       SET status = CASE WHEN EXISTS (
         SELECT 1 FROM dispatch_contexts
         WHERE task_id = tasks.id AND id != ? AND status IN ('pending', 'dispatched')
       ) THEN 'dispatched' ELSE 'blocked' END
       WHERE id = ? AND status IN ('dispatched', 'blocked')`
    )
    .run(dispatchId, taskId)
}
