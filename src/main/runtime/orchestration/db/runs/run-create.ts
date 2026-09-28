import type { RunRow } from '../../types'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'
import type { OrcaSessionId } from '../../../../../shared/orca-session-address'
import { mailboxAddressOf } from '../../orchestration-caller-identity'

// ── Runs ──

export function createRun(
  this: OrchestrationDb,
  params: {
    objective: string
    coordinatorHandle: string | null
    coordinatorPaneKey: string | null
    /** The coordinator's bare Orca session id when it is a structured session; see orca-session-address. */
    coordinatorOrcaSessionId?: OrcaSessionId | null
  }
): RunRow {
  const coordinator = {
    terminalHandle: params.coordinatorHandle,
    paneKey: params.coordinatorPaneKey,
    orcaSessionId: params.coordinatorOrcaSessionId ?? null
  }
  const id = generateId('run')
  this.db.exec('BEGIN IMMEDIATE')
  try {
    this.unbindOtherRunsForCoordinator(coordinator)
    this.db
      .prepare(
        `INSERT INTO runs (
           id, objective, coordinator_handle, coordinator_pane_key, coordinator_orca_session_id,
           coordinator_orca_session_id_generation, consumer_generation, legacy
         ) VALUES (?, ?, ?, ?, ?, 1, 1, 0)`
      )
      .run(
        id,
        params.objective,
        coordinator.terminalHandle,
        coordinator.paneKey,
        coordinator.orcaSessionId
      )
    const address = mailboxAddressOf(coordinator)
    if (address !== null) {
      this.rememberRunCoordinatorHandle(id, address)
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
