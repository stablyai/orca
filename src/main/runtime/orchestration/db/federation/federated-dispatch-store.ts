import { ORCHESTRATION_FEDERATION_FINISHED_WORKER_MAIL_PROTOCOL_VERSION } from '../../../../../shared/orchestration-runtime-capabilities'
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

/** Settled Dispatches whose host keeps their finished worker, which can still mail its coordinator. */
export function listFinishedFederatedWorkers(
  this: OrchestrationDb
): { dispatchId: string; environmentId: string; answerPending: boolean }[] {
  return this.db
    .prepare(
      `SELECT fd.dispatch_id AS dispatchId, fd.environment_id AS environmentId,
         EXISTS (SELECT 1 FROM federation_relay_items r
                  WHERE r.dispatch_id = fd.dispatch_id AND r.direction = 'to_worker'
                    AND r.acked_at IS NULL) AS answerPending
       FROM federated_dispatches fd
       INNER JOIN worker_dispatches wd ON wd.dispatch_id = fd.dispatch_id
       WHERE fd.protocol_version >= ? AND fd.remote_terminal_handle IS NOT NULL
         AND wd.state NOT IN ('starting', 'ready', 'stopping', 'start_unknown', 'stop_unknown')`
    )
    .all(ORCHESTRATION_FEDERATION_FINISHED_WORKER_MAIL_PROTOCOL_VERSION)
    .flatMap((row) =>
      typeof row?.dispatchId === 'string' && typeof row.environmentId === 'string'
        ? [
            {
              dispatchId: row.dispatchId,
              environmentId: row.environmentId,
              answerPending: row.answerPending === 1
            }
          ]
        : []
    )
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
       WHERE dispatch_id = ?`
    )
    .run(remoteRuntimeEpoch, dispatchId)
}

export type FederatedDispatchStoreMethods = {
  getFederatedDispatch: typeof getFederatedDispatch
  listFederatedDispatchesByIds: typeof listFederatedDispatchesByIds
  listActiveFederatedDispatches: typeof listActiveFederatedDispatches
  listFinishedFederatedWorkers: typeof listFinishedFederatedWorkers
  findNextTerminalFederatedDispatchPendingAcknowledgment: typeof findNextTerminalFederatedDispatchPendingAcknowledgment
  isFederatedDispatchRelayEligible: typeof isFederatedDispatchRelayEligible
  updateFederatedDispatchResources: typeof updateFederatedDispatchResources
  updateFederatedDispatchRuntimeEpoch: typeof updateFederatedDispatchRuntimeEpoch
}

export function attachFederatedDispatchStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getFederatedDispatch,
    listFederatedDispatchesByIds,
    listActiveFederatedDispatches,
    listFinishedFederatedWorkers,
    findNextTerminalFederatedDispatchPendingAcknowledgment,
    isFederatedDispatchRelayEligible,
    updateFederatedDispatchResources,
    updateFederatedDispatchRuntimeEpoch
  })
}
