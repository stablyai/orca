import type { WorkerDispatchRow } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'

/**
 * A start that dies before `prepareStartingWorkerAuthority` never filled the Dispatch context in,
 * and release re-proves identity through it — so the custody row written at terminal creation would
 * name a pane no release path could match. Copy that identity across.
 *
 * `capability_hash` stays null, so this grants nothing: it records which pane the Dispatch owns.
 *
 * No transaction: composes inside `failWorkerStart`'s.
 */
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
         SET assignee_handle = ?, assignee_pane_key = ?, process_incarnation = ?, host_scope = ?
       WHERE id = ? AND status = 'failed' AND capability_hash IS NULL`
    )
    .run(
      resource.terminal_handle,
      resource.pane_key,
      resource.process_incarnation,
      resource.host_scope,
      worker.dispatch_id
    )
}
