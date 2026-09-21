import type { DispatchContextRow } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'
import { transitionLifecycleWithDb } from '../lifecycle-transition'

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
  const task = db.getTask(taskId)
  if (!task || !['dispatched', 'blocked'].includes(task.status)) {
    return
  }
  const next = db.db
    .prepare(
      "SELECT 1 FROM dispatch_contexts WHERE task_id = ? AND id != ? AND status IN ('pending', 'dispatched')"
    )
    .get(taskId, dispatchId)
    ? 'dispatched'
    : 'blocked'
  if (task.status === next) {
    return
  }
  transitionLifecycleWithDb(db.db, {
    entity: 'task',
    id: taskId,
    from: task.status,
    to: next
  })
}
