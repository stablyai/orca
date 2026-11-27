import { ORCHESTRATION_SESSION_WORKERS_LIMIT } from '../../../../../shared/orchestration-session-workers'
import type { OrchestrationDbConnection } from '../orchestration-db'
import { ABANDONED_HERE, isRemoteDispatchTerminal } from '../remote-owned/remote-dispatch-records'

export type RemoteConnectorWorker = {
  sessionId: string
  environmentId: string
  linkState: string | null
  status: string
  worker_state: string | null
  settledHere: number
}

export function readRemoteConnectorWorkers(
  connection: OrchestrationDbConnection,
  sessionIds: readonly string[]
): RemoteConnectorWorker[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixed aliases from the remote lineage, placement and dispatch schemas.
  const rows = connection.db
    .prepare(`
    SELECT l.creator_orca_session_id AS sessionId,
      COALESCE(d.environment_id, p.environment_id) AS environmentId,
      link.state AS linkState, COALESCE(d.status, 'pending') AS status,
      d.worker_state, COALESCE(d.task_settled_here, 0) AS settledHere
    FROM json_each(?1) s
    JOIN remote_worker_lineage l ON l.rowid IN (
      SELECT rowid FROM remote_worker_lineage
      WHERE creator_orca_session_id = s.value ORDER BY rowid DESC LIMIT ?2
    )
    LEFT JOIN remote_dispatches d ON d.dispatch_id = l.dispatch_id AND d.run_id = l.run_id
    LEFT JOIN remote_placements p ON p.request_key = l.request_key AND p.run_id = l.run_id
      AND p.state = 'reserved' AND l.dispatch_id IS NULL
    LEFT JOIN remote_run_links link ON link.conversation_id = COALESCE(d.conversation_id, p.conversation_id)
    WHERE l.creator_turn_source = 'connector' AND (d.dispatch_id IS NOT NULL OR p.task_id IS NOT NULL)
  `)
    .all(
      JSON.stringify([...new Set(sessionIds)]),
      ORCHESTRATION_SESSION_WORKERS_LIMIT
    ) as RemoteConnectorWorker[]
  return rows.filter((row) => row.settledHere !== ABANDONED_HERE && !isRemoteDispatchTerminal(row))
}
