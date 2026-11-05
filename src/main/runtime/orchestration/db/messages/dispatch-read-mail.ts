import type { OrchestrationDb } from '../orchestration-db'

/** The coordinator's latest mail the worker consumed; helpers' reports and mail it has not taken yet do not count. */
export function latestReadCoordinatorMailSequence(db: OrchestrationDb, dispatchId: string): number {
  const sequence = db.db
    .prepare(
      `SELECT MAX(sequence) AS sequence FROM messages
        WHERE to_handle = ? AND read = 1 AND type NOT IN ('worker_done', 'escalation', 'question')`
    )
    .get(`dispatch:${dispatchId}`)?.sequence
  return typeof sequence === 'number' ? sequence : 0
}
