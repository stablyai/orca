import type { WorkerDispatchRow } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'
import { dispatchAssigneeOrcaSessionId } from '../../dispatch-assignee-orca-session-id'

/** Copy pre-boot custody identity into the failed Dispatch so release can re-prove it; caller owns the transaction. */
export function recordFailedStartDispatchIdentity(
  db: OrchestrationDb,
  worker: WorkerDispatchRow
): void {
  const resource = db.getWorkerTerminalResourceByOwner(worker.dispatch_id)
  if (!resource || resource.terminal_handle !== worker.agent_terminal_handle) {
    return
  }
  db.db
    .prepare(
      `UPDATE dispatch_contexts
         SET assignee_handle = ?, assignee_pane_key = ?, assignee_orca_session_id = ?,
             process_incarnation = ?, host_scope = ?
       WHERE id = ? AND status IN ('failed', 'circuit_broken') AND process_incarnation IS NULL`
    )
    .run(
      resource.terminal_handle,
      resource.pane_key,
      dispatchAssigneeOrcaSessionId({
        handle: resource.terminal_handle,
        processIncarnation: resource.process_incarnation
      }),
      resource.process_incarnation,
      resource.host_scope,
      worker.dispatch_id
    )
}
