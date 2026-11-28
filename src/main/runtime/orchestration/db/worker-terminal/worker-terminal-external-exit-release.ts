import type { OrchestrationDb } from '../orchestration-db'

/** A terminal Orca was told it does not own has ended: record the end on the rows naming that exact
 *  process, so a worker that reused an external terminal stops offering a release nothing answers to.
 *  The incarnation is the ended process itself, whatever handle it was last known by, and leaves a
 *  successor in the same pane its own row. A chat is an external resource too, but its history
 *  stays readable through its unreleased row until a reference is saved, as
 *  `releaseExitedWorkerTerminalInTransaction` also requires. */
export function settleExternallyEndedWorkerTerminals(
  this: OrchestrationDb,
  processIncarnation: string | null
): number {
  if (!processIncarnation) {
    return 0
  }
  const { changes } = this.db
    .prepare(
      `UPDATE worker_terminal_resources
         SET release_state = 'released', ownership_state = 'released', retained_reason = NULL,
             auto_release_at = NULL,
             release_completed_at = datetime('now'), release_error = NULL, updated_at = datetime('now')
       WHERE process_incarnation = ?
         AND ownership_state = 'external'
         AND release_state IN ('not_requested', 'retained')
         AND terminal_handle NOT LIKE 'structworker\\_%' ESCAPE '\\'`
    )
    .run(processIncarnation)
  return Number(changes)
}

export type WorkerTerminalExternalExitReleaseMethods = {
  settleExternallyEndedWorkerTerminals: typeof settleExternallyEndedWorkerTerminals
}

export function attachWorkerTerminalExternalExitRelease(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    settleExternallyEndedWorkerTerminals
  })
}
