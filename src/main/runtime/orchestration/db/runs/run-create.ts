import { resolveRunActor } from './run-actor'
import { recordRunCaller } from './run-authority-store'
import type { RunRow } from '../../types'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'
import type { OrcaSessionId } from '../../../../../shared/orca-session-address'
import { mailboxAddressOf } from '../../orchestration-caller-identity'

// ── Runs ──

export function createRun(
  this: OrchestrationDb,
  params: {
    processIncarnation?: string | null
    recordReceipt?: (run: RunRow) => void
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
    orcaSessionId: params.coordinatorOrcaSessionId ?? null,
    processIncarnation: params.processIncarnation ?? null
  }
  const id = generateId('run')
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const actor = resolveRunActor(this, coordinator)
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
    const origin =
      actor.kind === 'local'
        ? {
            dispatch: actor.dispatch.id,
            task: actor.dispatch.task_id,
            parent: actor.dispatch.run_id,
            home: null
          }
        : actor.kind === 'remote'
          ? {
              dispatch: actor.attachment.dispatch_id,
              task: actor.attachment.task_id,
              parent: actor.attachment.home_run_id,
              home: actor.attachment.home_peer_fingerprint
            }
          : { dispatch: null, task: null, parent: null, home: null }
    this.db
      .prepare(`UPDATE run_authority SET creating_dispatch_id = ?, creating_task_id = ?,
      parent_run_id = ?, creating_home_peer = ?, owner_task_id = ?, owner_home_peer = ? WHERE run_id = ?`)
      .run(origin.dispatch, origin.task, origin.parent, origin.home, origin.task, origin.home, id)
    recordRunCaller(this, id, coordinator, undefined, undefined)
    const address = mailboxAddressOf(coordinator)
    if (address !== null) {
      this.rememberRunCoordinatorHandle(id, address)
    }
    const run = this.getRun(id)
    if (!run) {
      throw new Error('Created Run is missing')
    }
    params.recordReceipt?.(run)
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
