import type { FederatedDispatchRow } from '../db/orchestration-records'
import { OrchestrationError } from '../orchestration-error'
import type { OrchestrationDb } from '../db/orchestration-db'

export function getFederatedDispatch(
  this: OrchestrationDb,
  dispatchId: string
): FederatedDispatchRow | undefined {
  return this.db
    .prepare('SELECT * FROM federated_dispatches WHERE dispatch_id = ?')
    .get(dispatchId) as FederatedDispatchRow | undefined
}

/** One statement for a whole worker-list page; the per-id lookup was an N+1 over the page. */
export function listFederatedDispatchesByIds(
  this: OrchestrationDb,
  dispatchIds: readonly string[]
): FederatedDispatchRow[] {
  if (dispatchIds.length === 0) {
    return []
  }
  return this.db
    .prepare(
      `SELECT * FROM federated_dispatches
        WHERE dispatch_id IN (SELECT value FROM json_each(?))`
    )
    .all(JSON.stringify([...dispatchIds])) as FederatedDispatchRow[]
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

export function updateFederatedDispatchRuntimeEpoch(
  this: OrchestrationDb,
  dispatchId: string,
  remoteRuntimeEpoch: string
): void {
  this.db
    .prepare(
      `UPDATE federated_dispatches
       SET remote_runtime_epoch = ?, updated_at = datetime('now')
       WHERE dispatch_id = ? AND remote_runtime_epoch IS NOT ?`
    )
    .run(remoteRuntimeEpoch, dispatchId, remoteRuntimeEpoch)
}

export function setFederatedHomeImportSequence(
  this: OrchestrationDb,
  dispatchId: string,
  sequence: number
): void {
  this.db
    .prepare(
      `UPDATE federated_dispatches
       SET to_home_imported_sequence = ?, updated_at = datetime('now')
       WHERE dispatch_id = ? AND to_home_imported_sequence < ?`
    )
    .run(sequence, dispatchId, sequence)
}

export function recordFederatedHomeAcknowledgment(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    remoteRuntimeEpoch: string
    sequence: number
  }
): void {
  const federated = this.getFederatedDispatch(params.dispatchId)
  if (
    !federated ||
    !Number.isInteger(params.sequence) ||
    params.sequence < 0 ||
    params.sequence > federated.to_home_imported_sequence
  ) {
    throw new OrchestrationError(
      'request_mismatch',
      `Federation acknowledgment for ${params.dispatchId} exceeds imported relay state.`
    )
  }
  this.db
    .prepare(
      `UPDATE federated_dispatches
       SET remote_runtime_epoch = ?,
           to_home_acknowledged_sequence = CASE
             WHEN remote_runtime_epoch = ?
               THEN MAX(to_home_acknowledged_sequence, ?)
             ELSE ?
           END,
           updated_at = datetime('now')
       WHERE dispatch_id = ?`
    )
    .run(
      params.remoteRuntimeEpoch,
      params.remoteRuntimeEpoch,
      params.sequence,
      params.sequence,
      params.dispatchId
    )
}

export type FederatedDispatchStoreMethods = {
  getFederatedDispatch: typeof getFederatedDispatch
  listFederatedDispatchesByIds: typeof listFederatedDispatchesByIds
  listActiveFederatedDispatches: typeof listActiveFederatedDispatches
  findNextTerminalFederatedDispatchPendingAcknowledgment: typeof findNextTerminalFederatedDispatchPendingAcknowledgment
  isFederatedDispatchRelayEligible: typeof isFederatedDispatchRelayEligible
  updateFederatedDispatchResources: typeof updateFederatedDispatchResources
  updateFederatedDispatchRuntimeEpoch: typeof updateFederatedDispatchRuntimeEpoch
  setFederatedHomeImportSequence: typeof setFederatedHomeImportSequence
  recordFederatedHomeAcknowledgment: typeof recordFederatedHomeAcknowledgment
}

export function attachFederatedDispatchStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getFederatedDispatch,
    listFederatedDispatchesByIds,
    listActiveFederatedDispatches,
    findNextTerminalFederatedDispatchPendingAcknowledgment,
    isFederatedDispatchRelayEligible,
    updateFederatedDispatchResources,
    updateFederatedDispatchRuntimeEpoch,
    setFederatedHomeImportSequence,
    recordFederatedHomeAcknowledgment
  })
}
