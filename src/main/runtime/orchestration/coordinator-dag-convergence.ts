/** Whether the task DAG has finished, and the stuck-DAG warning when it can never finish. */
import type { OrchestrationDb } from './db'

export type DagConvergence = 'empty' | 'all-done' | 'active'

export function evaluateDagConvergence(
  db: OrchestrationDb,
  onLog: (msg: string) => void
): DagConvergence {
  const tasks = db.listTasks()
  if (tasks.length === 0) {
    return 'empty'
  }

  const allDone = tasks.every((t) => t.status === 'completed' || t.status === 'failed')
  if (allDone) {
    return 'all-done'
  }

  // Why: no active tasks but some blocked → dependencies can never be satisfied (stuck).
  const active = tasks.filter(
    (t) => t.status === 'ready' || t.status === 'dispatched' || t.status === 'pending'
  )
  const blocked = tasks.filter((t) => t.status === 'blocked')
  if (active.length === 0 && blocked.length > 0) {
    onLog(
      `Stuck: ${blocked.length} tasks blocked with no active tasks. Resolve decision gates to continue.`
    )
  }

  return 'active'
}
