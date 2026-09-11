import type { RunRow } from '../../types'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'
import { runCoordinatorBinding, type RunCoordinatorParam } from './run-coordinator-binding'

// ── Runs ──

export function createRun(
  this: OrchestrationDb,
  params: { objective: string } & RunCoordinatorParam
): RunRow {
  const id = generateId('run')
  const coordinator = runCoordinatorBinding(params)
  this.db.exec('BEGIN IMMEDIATE')
  try {
    this.unbindOtherRunsForPrincipal(coordinator.principalId)
    this.db
      .prepare(
        `INSERT INTO runs (
           id, objective, coordinator_handle, coordinator_pane_key, coordinator_principal,
           consumer_generation, legacy
         ) VALUES (?, ?, ?, ?, ?, 1, 0)`
      )
      .run(
        id,
        params.objective,
        coordinator.terminalHandle,
        coordinator.paneKey,
        coordinator.principalId
      )
    if (coordinator.terminalHandle !== null) {
      this.rememberRunCoordinatorHandle(id, coordinator.terminalHandle)
    }
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
  return this.getRun(id) as RunRow
}

export type RunCreateMethods = {
  createRun: typeof createRun
}

export function attachRunCreate(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createRun
  })
}
