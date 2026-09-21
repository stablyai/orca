import type { WorkerDispatchRow } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'

/** Identity of a terminal this worker-start created and never handed to an owner. */
export type FailedStartTerminalAdoption = {
  terminalHandle: string
  worktreeId: string | null
  paneKey: string
  processIncarnation: string
  hostScope?: string | null
}

/**
 * A start that dies before `prepareStartingWorkerAuthority` leaves the terminal it created with no
 * owner, so no release path can ever close it and the fleet can only say `inspect`. Record the
 * ownership the successful path would have recorded, so ordinary `worker-release` owns the cleanup.
 *
 * No transaction: composes inside `failWorkerStart`'s.
 */
export function adoptFailedStartTerminal(
  db: OrchestrationDb,
  worker: WorkerDispatchRow,
  adoption: FailedStartTerminalAdoption | undefined
): void {
  if (!adoption || worker.agent_terminal_handle !== adoption.terminalHandle) {
    return
  }
  if (db.getWorkerTerminalResourceByOwner(worker.dispatch_id)) {
    return
  }
  // A second owner for one process could close it twice, or close a terminal already handed on.
  const conflict = db.db
    .prepare(
      `SELECT 1 FROM worker_terminal_resources
        WHERE ownership_state <> 'released'
          AND (terminal_handle = ? OR process_incarnation = ?) LIMIT 1`
    )
    .get(adoption.terminalHandle, adoption.processIncarnation)
  if (conflict) {
    return
  }
  db.createWorkerTerminalResourceStatement({
    dispatchId: worker.dispatch_id,
    worktreeId: adoption.worktreeId ?? worker.worktree_id,
    terminalHandle: adoption.terminalHandle,
    paneKey: adoption.paneKey,
    processIncarnation: adoption.processIncarnation,
    endpointId: worker.runtime_epoch ?? null,
    endpointIncarnation: adoption.processIncarnation,
    hostScope: adoption.hostScope ?? null,
    ownership: 'owned'
  })
  // Release re-proves identity through the Dispatch context, which a failed start never filled in.
  // This records which pane the Dispatch owns; `capability_hash` stays null, so it grants nothing.
  db.db
    .prepare(
      `UPDATE dispatch_contexts
         SET assignee_handle = ?, assignee_pane_key = ?, process_incarnation = ?, host_scope = ?
       WHERE id = ? AND status = 'failed' AND capability_hash IS NULL`
    )
    .run(
      adoption.terminalHandle,
      adoption.paneKey,
      adoption.processIncarnation,
      adoption.hostScope ?? null,
      worker.dispatch_id
    )
}
