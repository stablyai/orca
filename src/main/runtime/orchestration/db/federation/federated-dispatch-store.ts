import type { FederatedDispatchRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

export function getFederatedDispatch(
  this: OrchestrationDb,
  dispatchId: string
): FederatedDispatchRow | undefined {
  return this.db
    .prepare('SELECT * FROM federated_dispatches WHERE dispatch_id = ?')
    .get(dispatchId) as FederatedDispatchRow | undefined
}

export function listActiveFederatedDispatches(
  this: OrchestrationDb,
  runId?: string
): FederatedDispatchRow[] {
  return this.db
    .prepare(
      `SELECT fd.*
       FROM federated_dispatches fd
       INNER JOIN dispatch_contexts dc ON dc.id = fd.dispatch_id
       INNER JOIN worker_dispatches wd ON wd.dispatch_id = fd.dispatch_id
       WHERE wd.state IN ('starting', 'ready', 'stopping', 'start_unknown', 'stop_unknown')
         AND (? IS NULL OR dc.run_id = ?)
       ORDER BY fd.rowid`
    )
    .all(runId ?? null, runId ?? null) as FederatedDispatchRow[]
}

export function findNextTerminalFederatedDispatchPendingAcknowledgment(
  this: OrchestrationDb,
  afterRowId: number
): { dispatchId: string; rowId: number } | undefined {
  return this.db
    .prepare(
      `SELECT fd.dispatch_id AS dispatchId, fd.rowid AS rowId
       FROM federated_dispatches fd
       INNER JOIN worker_dispatches wd ON wd.dispatch_id = fd.dispatch_id
       WHERE wd.state NOT IN ('starting', 'ready', 'stopping', 'start_unknown', 'stop_unknown')
         AND fd.to_home_acknowledged_sequence < fd.to_home_imported_sequence
         AND fd.rowid > ?
       ORDER BY fd.rowid
       LIMIT 1`
    )
    .get(afterRowId) as { dispatchId: string; rowId: number } | undefined
}

export function isFederatedDispatchRelayEligible(
  this: OrchestrationDb,
  dispatchId: string
): boolean {
  return Boolean(
    this.db
      .prepare(
        `SELECT 1
         FROM federated_dispatches fd
         INNER JOIN worker_dispatches wd ON wd.dispatch_id = fd.dispatch_id
         WHERE fd.dispatch_id = ?
           AND (
             wd.state IN ('starting', 'ready', 'stopping', 'start_unknown', 'stop_unknown')
             OR (
               fd.to_home_acknowledged_sequence < fd.to_home_imported_sequence
             )
           )`
      )
      .get(dispatchId)
  )
}

export function updateFederatedDispatchResources(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    remoteRuntimeEpoch: string
    worktreeId: string
    terminalHandle: string
  }
): FederatedDispatchRow {
  this.db
    .prepare(
      `UPDATE federated_dispatches
       SET remote_runtime_epoch = ?, remote_worktree_id = ?, remote_terminal_handle = ?,
           updated_at = datetime('now')
       WHERE dispatch_id = ?`
    )
    .run(params.remoteRuntimeEpoch, params.worktreeId, params.terminalHandle, params.dispatchId)
  const row = this.getFederatedDispatch(params.dispatchId)
  if (!row) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Federated Dispatch ${params.dispatchId} was not found.`
    )
  }
  return row
}

export type FederatedDispatchStoreMethods = {
  getFederatedDispatch: typeof getFederatedDispatch
  listActiveFederatedDispatches: typeof listActiveFederatedDispatches
  findNextTerminalFederatedDispatchPendingAcknowledgment: typeof findNextTerminalFederatedDispatchPendingAcknowledgment
  isFederatedDispatchRelayEligible: typeof isFederatedDispatchRelayEligible
  updateFederatedDispatchResources: typeof updateFederatedDispatchResources
}

export function attachFederatedDispatchStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getFederatedDispatch,
    listActiveFederatedDispatches,
    findNextTerminalFederatedDispatchPendingAcknowledgment,
    isFederatedDispatchRelayEligible,
    updateFederatedDispatchResources
  })
}
