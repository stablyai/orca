import type { RunRow } from '../orchestration-records'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'
import { RUN_COLUMN_LIST } from '../row-column-lists'
import { exposeRunTimestamps } from '../utc-timestamp'

// Any terminal or session binding wins, so an older binary's run-use still fences the external coordinator.
const RUNS_BOUND_TO_EXTERNAL_COORDINATOR_SQL = `SELECT ${RUN_COLUMN_LIST} FROM runs
         WHERE coordinator_client_fingerprint = ? AND legacy = 0
           AND coordinator_handle IS NULL AND coordinator_pane_key IS NULL
           AND coordinator_orca_session_id IS NULL
         ORDER BY rowid DESC`

/** The fingerprint that coordinates this Run now, or null when a terminal or session holds it. */
export function currentRunExternalCoordinator(
  run: Pick<
    RunRow,
    | 'coordinator_client_fingerprint'
    | 'coordinator_handle'
    | 'coordinator_pane_key'
    | 'coordinator_orca_session_id'
    | 'legacy'
  >
): string | null {
  return run.legacy === 0 &&
    run.coordinator_handle === null &&
    run.coordinator_pane_key === null &&
    run.coordinator_orca_session_id === null
    ? run.coordinator_client_fingerprint
    : null
}

export function createExternalRun(
  this: OrchestrationDb,
  params: { objective: string; clientFingerprint: string }
): RunRow {
  const id = generateId('run')
  this.db
    .prepare(
      `INSERT INTO runs (id, objective, coordinator_client_fingerprint, consumer_generation, legacy)
       VALUES (?, ?, ?, 1, 0)`
    )
    .run(id, params.objective, params.clientFingerprint)
  const run = this.getRun(id)
  if (!run) {
    throw new Error(`Run not found after insert: ${id}`)
  }
  return run
}

/** Runs this external coordinator holds, newest (current) first; like a terminal it keeps every Run it created. */
export function runsBoundToExternalCoordinator(
  this: OrchestrationDb,
  clientFingerprint: string
): RunRow[] {
  const rows = this.db.prepare(RUNS_BOUND_TO_EXTERNAL_COORDINATOR_SQL).all(clientFingerprint)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the explicit run projection returns the shape its schema and row type define, like every row cast in db/.
  return (rows as RunRow[]).map(exposeRunTimestamps)
}

export type RunExternalCoordinatorMethods = {
  createExternalRun: typeof createExternalRun
  runsBoundToExternalCoordinator: typeof runsBoundToExternalCoordinator
}

export function attachRunExternalCoordinator(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createExternalRun,
    runsBoundToExternalCoordinator
  })
}
