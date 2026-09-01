import { OrchestrationError } from '../../orchestration-error'
import type {
  WorkerTerminalResourceRow,
  WorkerTerminalRetainedReason
} from '../../worker-terminal-ownership'
import { parseWorkerTerminalPriorOwnerIds } from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'

type WorkerDispositionCandidate = {
  dispatch_id: string
  origin_dispatch_id: string | null
  prior_owner_dispatch_ids: string | null
}

// The Run index bounds candidate lookup; accepted-report proof uses Dispatch primary keys.
export function listRequiredWorkerDispositions(db: OrchestrationDb, runId: string): string[] {
  const candidates = db.db
    .prepare(
      `SELECT current.id AS dispatch_id, resource.origin_dispatch_id,
              resource.prior_owner_dispatch_ids
         FROM dispatch_contexts AS current INDEXED BY idx_dispatch_run_status
         JOIN worker_dispatches current_worker ON current_worker.dispatch_id = current.id
         LEFT JOIN worker_terminal_resources resource
           ON resource.owner_dispatch_id = current.id
         LEFT JOIN federated_dispatches federated ON federated.dispatch_id = current.id
        WHERE current.run_id = ?
          AND (
            (
              federated.dispatch_id IS NOT NULL
              AND (
                resource.id IS NULL
                OR (
                  resource.release_state = 'not_requested'
                  AND resource.retained_reason IS NOT 'federation_unsupported'
                )
              )
            )
            OR (
              resource.id IS NOT NULL
              AND (
                resource.release_state IN ('requested', 'releasing', 'unknown')
                OR (
                  resource.release_state = 'retained'
                  AND resource.retained_reason = 'identity_unproven'
                )
                OR (
                  resource.release_state = 'not_requested'
                  AND resource.ownership_state = 'owned'
                  AND current_worker.state != 'ready'
                )
              )
            )
          )
        ORDER BY current.rowid`
    )
    .all(runId) as WorkerDispositionCandidate[]
  const hasAcceptedReport = db.db.prepare(
    `SELECT 1
       FROM worker_dispatches
      WHERE dispatch_id = ? AND worker_report_settled_at IS NOT NULL`
  )
  return candidates.flatMap((candidate) => {
    const priorOwners = candidate.prior_owner_dispatch_ids
      ? (parseWorkerTerminalPriorOwnerIds(candidate.prior_owner_dispatch_ids) ?? [])
      : []
    const relatedDispatchIds = [
      candidate.dispatch_id,
      ...(candidate.origin_dispatch_id ? [candidate.origin_dispatch_id] : []),
      ...priorOwners
    ]
    return relatedDispatchIds.some((dispatchId) => hasAcceptedReport.get(dispatchId))
      ? [candidate.dispatch_id]
      : []
  })
}

// The Run home cannot close a connected-server terminal, but it can persist the explicit retention.
export function retainFederatedWorkerDisposition(
  this: OrchestrationDb,
  dispatchId: string,
  reason: Extract<WorkerTerminalRetainedReason, 'federation_unsupported' | 'user_requested'>
): WorkerTerminalResourceRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const federated = this.getFederatedDispatch(dispatchId)
    const worker = this.getWorkerDispatch(dispatchId)
    if (!federated || !worker) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Federated Dispatch ${dispatchId} was not found.`
      )
    }
    let resource = this.getWorkerTerminalResourceByOwner(dispatchId)
    if (!resource) {
      const terminalHandle = federated.remote_terminal_handle ?? worker.agent_terminal_handle
      if (!terminalHandle) {
        throw new OrchestrationError(
          'operation_unknown',
          `Federated Dispatch ${dispatchId} has no recorded worker terminal.`
        )
      }
      resource = this.createWorkerTerminalResourceStatement({
        dispatchId,
        worktreeId: federated.remote_worktree_id ?? worker.worktree_id,
        terminalHandle,
        paneKey: null,
        processIncarnation: null,
        hostScope: JSON.stringify({
          kind: 'federated',
          environmentId: federated.environment_id,
          peerFingerprint: federated.peer_fingerprint
        }),
        ownership: 'external'
      })
    }
    this.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET release_state = 'retained', retained_reason = ?, updated_at = datetime('now')
         WHERE id = ? AND release_state != 'released'`
      )
      .run(reason, resource.id)
    const retained = this.getWorkerTerminalResource(resource.id) as WorkerTerminalResourceRow
    this.db.exec('COMMIT')
    return retained
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function requireRunWorkerDisposition(
  this: OrchestrationDb,
  runId: string,
  context: { acknowledgedDeliveryId?: string } = {}
): void {
  const dispatchIds = listRequiredWorkerDispositions(this, runId)
  if (dispatchIds.length === 0) {
    return
  }
  throw new OrchestrationError(
    'worker_disposition_required',
    `Run ${runId} has worker terminals without disposition: ${dispatchIds.join(', ')}. Release, re-dispatch, or explicitly retain each worker before continuing.`,
    {
      effectsApplied: Boolean(context.acknowledgedDeliveryId),
      runId,
      dispatchIds,
      ...(context.acknowledgedDeliveryId ? { acknowledged: context.acknowledgedDeliveryId } : {})
    }
  )
}

export type WorkerDispositionBarrierMethods = {
  requireRunWorkerDisposition: typeof requireRunWorkerDisposition
  retainFederatedWorkerDisposition: typeof retainFederatedWorkerDisposition
}

export function attachWorkerDispositionBarrier(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    requireRunWorkerDisposition,
    retainFederatedWorkerDisposition
  })
}
