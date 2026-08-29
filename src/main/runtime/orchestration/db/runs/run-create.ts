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
    coordinatorProcessIncarnation?: string | null
    coordinatorHostScope?: string | null
  }
): RunRow {
  const id = generateId('run')
  this.db.exec('BEGIN IMMEDIATE')
  try {
    this.unbindOtherRunsForPane(params.coordinatorPaneKey, {
      handle: params.coordinatorHandle,
      paneKey: params.coordinatorPaneKey,
      processIncarnation: params.coordinatorProcessIncarnation ?? null,
      hostScope: params.coordinatorHostScope ?? null
    })
    this.db
      .prepare(
        `INSERT INTO runs (
           id, objective, coordinator_handle, coordinator_pane_key,
           coordinator_process_incarnation, coordinator_host_scope,
           coordinator_authority_revision, consumer_generation, legacy
         ) VALUES (?, ?, ?, ?, ?, ?, 0, 1, 0)`
      )
      .run(
        id,
        params.objective,
        params.coordinatorHandle,
        params.coordinatorPaneKey,
        params.coordinatorProcessIncarnation ?? null,
        params.coordinatorHostScope ?? null
      )
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
