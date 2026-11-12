import type { OrchestrationDb } from '../orchestration-db'

/** Whether the stopping turn's worker_done was rejected: the coordinator already holds that rejection
 *  with its reason, so the turn did not end without reporting. A later turn's silence is still news. */
export function rejectedReportInTurn(
  db: OrchestrationDb,
  dispatchId: string,
  turnStartedAt: number | undefined
): boolean {
  const dispatch = db.getDispatchContextById(dispatchId)
  // The worker's own handle sent it, as when Orca restarted under its report; another terminal's says nothing.
  if (!dispatch?.assignee_handle || turnStartedAt === undefined) {
    return false
  }
  const row = db.db
    .prepare(
      `SELECT 1 FROM messages
        WHERE run_id = ? AND from_handle = ? AND type = 'worker_done'
          AND json_valid(payload)
          AND json_extract(payload, '$.dispatchId') = ?
          AND json_type(payload, '$._orcaLifecycleRejection.code') IS 'text'
          AND created_at >= datetime(?, 'unixepoch')
        LIMIT 1`
    )
    // created_at has whole seconds.
    .get(dispatch.run_id, dispatch.assignee_handle, dispatchId, Math.floor(turnStartedAt / 1000))
  return row !== undefined
}
