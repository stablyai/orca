import type { WorkerDispatchRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import { reconcileTaskAfterDispatchInterruption } from '../dispatch-context/task-dispatch-reconciliation'

export function reconcileFederatedWorkerStart(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    state: 'ready' | 'failed' | 'stopped' | 'start_unknown'
    stage: string
    lastError?: string | null
    worktreeId?: string | null
    terminalHandle?: string | null
    setupState?: string
    effects?: unknown[]
    residualResources?: unknown[]
  }
): WorkerDispatchRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(params.dispatchId)
    const worker = this.getWorkerDispatch(params.dispatchId)
    if (!dispatch || !worker) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Federated Dispatch ${params.dispatchId} was not found.`
      )
    }
    if (!['starting', 'start_unknown'].includes(worker.state)) {
      this.db.exec('COMMIT')
      return worker
    }

    if (params.state === 'ready') {
      this.db
        .prepare(
          `UPDATE worker_dispatches
           SET state = 'ready', stage = ?, worktree_id = COALESCE(?, worktree_id),
               agent_terminal_handle = COALESCE(?, agent_terminal_handle), setup_state = ?,
               effects = COALESCE(?, effects),
               residual_resources = COALESCE(?, residual_resources), last_error = NULL,
               updated_at = datetime('now')
           WHERE dispatch_id = ? AND state IN ('starting', 'start_unknown')`
        )
        .run(
          params.stage,
          params.worktreeId ?? null,
          params.terminalHandle ?? null,
          params.setupState ?? worker.setup_state,
          // Why: keep the stored JSON as-is when the peer omits it — re-parsing it here throws on any malformed legacy row.
          params.effects ? JSON.stringify(params.effects) : null,
          params.residualResources ? JSON.stringify(params.residualResources) : null,
          params.dispatchId
        )
      this.db
        .prepare(
          "UPDATE dispatch_contexts SET status = 'dispatched' WHERE id = ? AND status = 'pending'"
        )
        .run(params.dispatchId)
      this.db
        .prepare(
          "UPDATE tasks SET status = 'dispatched', completed_at = NULL WHERE id = ? AND status = 'blocked'"
        )
        .run(dispatch.task_id)
    } else if (params.state === 'start_unknown') {
      this.db
        .prepare(
          `UPDATE worker_dispatches
           SET stage = ?, last_error = ?, updated_at = datetime('now')
           WHERE dispatch_id = ? AND state IN ('starting', 'start_unknown')`
        )
        .run(params.stage, params.lastError ?? worker.last_error, params.dispatchId)
    } else {
      const reason = params.lastError ?? `The worker server reported ${params.state}.`
      this.db
        .prepare(
          `UPDATE worker_dispatches
           SET state = ?, stage = ?, last_error = ?, updated_at = datetime('now')
           WHERE dispatch_id = ? AND state IN ('starting', 'start_unknown')`
        )
        .run(params.state, params.stage, reason, params.dispatchId)
      this.db
        .prepare(
          `UPDATE dispatch_contexts
           SET status = 'failed', last_failure = ?, completed_at = datetime('now'),
               capability_revoked_at = COALESCE(capability_revoked_at, datetime('now'))
           WHERE id = ? AND status IN ('pending', 'dispatched')`
        )
        .run(reason, params.dispatchId)
      reconcileTaskAfterDispatchInterruption(this, dispatch.task_id, params.dispatchId)
      this.db
        .prepare(
          `UPDATE tasks SET status = 'failed', completed_at = datetime('now')
           WHERE id = ? AND status IN ('blocked', 'dispatched')
             AND NOT EXISTS (
               SELECT 1 FROM dispatch_contexts
               WHERE task_id = tasks.id AND status IN ('pending', 'dispatched')
             )`
        )
        .run(dispatch.task_id)
      this.closeQuestionsForDispatch(params.dispatchId)
    }
    this.db.exec('COMMIT')
    return this.getWorkerDispatch(params.dispatchId) as WorkerDispatchRow
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type FederatedWorkerStartReconcileMethods = {
  reconcileFederatedWorkerStart: typeof reconcileFederatedWorkerStart
}

export function attachFederatedWorkerStartReconcile(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    reconcileFederatedWorkerStart
  })
}
