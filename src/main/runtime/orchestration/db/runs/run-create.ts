import type { RunRow } from '../../types'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'

// ── Runs ──

export function createRun(
  this: OrchestrationDb,
  params: {
    objective: string
    coordinatorHandle: string
    coordinatorPaneKey: string
  }
): RunRow {
  const id = generateId('run')
  this.db.exec('BEGIN IMMEDIATE')
  try {
    this.unbindOtherRunsForPane(params.coordinatorPaneKey)
    this.db
      .prepare(
        `INSERT INTO runs (
           id, objective, coordinator_handle, coordinator_pane_key,
           consumer_generation, legacy
         ) VALUES (?, ?, ?, ?, 1, 0)`
      )
      .run(id, params.objective, params.coordinatorHandle, params.coordinatorPaneKey)
    this.rememberRunCoordinatorHandle(id, params.coordinatorHandle)
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
