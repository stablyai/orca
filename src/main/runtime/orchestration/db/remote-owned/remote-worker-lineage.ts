import type { OrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address'
import type { OrchestrationDb } from '../orchestration-db'
import { recordedCreatorIdentity, type DispatchCreator } from '../dispatch-depth'

export function rememberRemoteWorkerCreator(
  db: OrchestrationDb,
  runId: string,
  requestKey: string,
  creator: DispatchCreator
): void {
  const identity = recordedCreatorIdentity(creator)
  db.db
    .prepare(`INSERT OR IGNORE INTO remote_worker_lineage
    (request_key, run_id, creator_handle, creator_orca_session_id, creator_turn_source)
    VALUES (?, ?, ?, ?, ?)`)
    .run(
      requestKey,
      runId,
      identity.creatorHandle,
      identity.creatorOrcaSessionId,
      identity.creatorTurnSource
    )
}

export function bindRemoteWorkerCreator(
  db: OrchestrationDb,
  requestKey: string,
  dispatchId: string
): void {
  db.db
    .prepare(`UPDATE remote_worker_lineage SET dispatch_id = ?
    WHERE request_key = ? AND dispatch_id IS NULL`)
    .run(dispatchId, requestKey)
}

export function remoteWorkerCreator(db: OrchestrationDb, dispatchId: string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixed columns from the lineage table.
  return db.db
    .prepare(`SELECT run_id, creator_handle, creator_orca_session_id, creator_turn_source
    FROM remote_worker_lineage WHERE dispatch_id = ?`)
    .get(dispatchId) as
    | {
        run_id: string
        creator_handle: string | null
        creator_orca_session_id: OrcaSessionId | null
        creator_turn_source: 'connector' | null
      }
    | undefined
}
