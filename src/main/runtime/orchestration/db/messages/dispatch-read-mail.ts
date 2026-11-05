import type { OrchestrationDb } from '../orchestration-db'

/** How much of the coordinator's mail the worker consumed, in any order; helpers' reports, heartbeats and mail it has not taken yet do not count. */
export function readCoordinatorMailCount(db: OrchestrationDb, dispatchId: string): number {
  const count = db.db
    .prepare(
      `SELECT COUNT(*) AS count FROM messages
        WHERE to_handle = ? AND read = 1 AND type NOT IN ('worker_done', 'escalation', 'question', 'heartbeat')`
    )
    .get(`dispatch:${dispatchId}`)?.count
  return typeof count === 'number' ? count : 0
}
