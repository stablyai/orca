import type { DispatchContextRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import { dispatchAssigneeOrcaSessionId } from '../../dispatch-assignee-orca-session-id'

/**
 * Move an active Dispatch's lifecycle authority to another live terminal, so a successor agent
 * session continues the same Task and Dispatch (issue #36765). The guarded write mirrors
 * prepareStartingWorkerAuthority's authority attach for a mid-flight handoff.
 */
export function rebindDispatchAssignee(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    handle: string
    paneKey: string
    processIncarnation: string
    hostScope?: string | null
  }
): DispatchContextRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(params.dispatchId)
    if (!dispatch || (dispatch.status !== 'pending' && dispatch.status !== 'dispatched')) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${params.dispatchId} is not active; only an active Dispatch can be rebound.`
      )
    }
    const worker = this.getWorkerDispatch(params.dispatchId)
    if (worker && ['starting', 'stopping', 'stop_unknown'].includes(worker.state)) {
      // prepareStartingWorkerAuthority owns the binding while starting; worker-stop owns it while
      // stopping. Only a working (or unproven) worker's Dispatch follows a handoff.
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${params.dispatchId} worker is ${worker.state}; its binding cannot be rebound.`
      )
    }
    const conflicting = this.findActiveDispatchForAssignee(params.handle, params.paneKey)
    if (conflicting && conflicting.id !== params.dispatchId) {
      throw new OrchestrationError(
        'invalid_argument',
        `Terminal ${params.handle} already has an active dispatch (${conflicting.id} for task ${conflicting.task_id})`
      )
    }
    const update = this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET assignee_handle = ?, assignee_pane_key = ?, assignee_orca_session_id = ?,
             process_incarnation = ?, host_scope = COALESCE(?, host_scope),
             capability_revoked_at = NULL,
             consumer_generation = consumer_generation + 1
         WHERE id = ? AND status IN ('pending', 'dispatched')`
      )
      .run(
        params.handle,
        params.paneKey,
        dispatchAssigneeOrcaSessionId({
          handle: params.handle,
          processIncarnation: params.processIncarnation
        }),
        params.processIncarnation,
        params.hostScope ?? null,
        params.dispatchId
      )
    if (update.changes !== 1) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${params.dispatchId} changed while its assignee was being rebound.`
      )
    }
    if (worker) {
      this.db
        .prepare(
          `UPDATE worker_dispatches
           SET agent_terminal_handle = ?, updated_at = datetime('now')
           WHERE dispatch_id = ?`
        )
        .run(params.handle, params.dispatchId)
    }
    // Pending dispatch mail was addressed to the prior consumer's custody; fence it so the
    // follow-up push re-delivers it under the new assignee instead of the stale one.
    this.fenceUnacknowledgedMailboxDeliveries(`dispatch:${params.dispatchId}`)
    const rebound = this.getDispatchContextById(params.dispatchId) as DispatchContextRow
    this.db.exec('COMMIT')
    return rebound
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type DispatchAssigneeRebindMethods = {
  rebindDispatchAssignee: typeof rebindDispatchAssignee
}

export function attachDispatchAssigneeRebind(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    rebindDispatchAssignee
  })
}
