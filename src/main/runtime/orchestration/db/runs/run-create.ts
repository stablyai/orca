import type { RunRow } from '../../types'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'

// ── Runs ──

export function createRun(
  this: OrchestrationDb,
  params: {
    objective: string
    coordinatorHandle?: string | null
    coordinatorPaneKey?: string | null
    coordinatorAgentSessionId?: string | null
  }
): RunRow {
  const id = generateId('run')
  this.db.exec('BEGIN IMMEDIATE')
  try {
    if (params.coordinatorPaneKey) {
      this.unbindOtherRunsForPane(params.coordinatorPaneKey)
    }
    this.db
      .prepare(
        `INSERT INTO runs (
           id, objective, coordinator_handle, coordinator_pane_key, coordinator_agent_session_id,
           consumer_generation, legacy
         ) VALUES (?, ?, ?, ?, ?, 1, 0)`
      )
      .run(
        id,
        params.objective,
        params.coordinatorHandle ?? null,
        params.coordinatorPaneKey ?? null,
        params.coordinatorAgentSessionId ?? null
      )
    if (params.coordinatorHandle) {
      this.rememberRunCoordinatorHandle(id, params.coordinatorHandle)
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
