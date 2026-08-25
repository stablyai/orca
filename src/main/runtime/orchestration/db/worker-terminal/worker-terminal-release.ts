import { WORKER_SETTLED_STATES } from '../../worker-terminal-ownership'
import type {
  WorkerTerminalResourceRow,
  WorkerTerminalRetainedReason
} from '../../worker-terminal-ownership'
import { OrchestrationError } from '../../orchestration-error'
import { parseWorkerTerminalPriorOwnerIds } from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'

export function requestWorkerTerminalRelease(
  this: OrchestrationDb,
  dispatchId: string
):
  | { disposition: 'requested'; resource: WorkerTerminalResourceRow }
  | { disposition: 'already_released'; resource: WorkerTerminalResourceRow }
  | {
      disposition: 'retained'
      resource: WorkerTerminalResourceRow | null
      reason: WorkerTerminalRetainedReason
    } {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(dispatchId)
    const worker = this.getWorkerDispatch(dispatchId)
    if (!dispatch) {
      throw new OrchestrationError('dispatch_not_found', `Dispatch ${dispatchId} was not found.`)
    }
    if (!worker) {
      if (!['completed', 'failed', 'circuit_broken'].includes(dispatch.status)) {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Dispatch ${dispatchId} is ${dispatch.status}; only a settled dispatch can release.`
        )
      }
      this.db.exec('COMMIT')
      return { disposition: 'retained', resource: null, reason: 'no_owned_resource' }
    }
    if (!WORKER_SETTLED_STATES.includes(worker.state)) {
      // Why: release is post-completion cleanup only; recording intent for an unsettled or
      // uncertain worker would let recovery close a terminal the coordinator never reviewed.
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${dispatchId} is ${worker.state}; only a settled worker can release. Use worker-stop to cancel an active worker.`
      )
    }
    const resource = this.getWorkerTerminalResourceByOwner(dispatchId)
    if (!resource) {
      const transferred = this.getWorkerTerminalResourceFormerlyOwnedBy(dispatchId)
      this.db.exec('COMMIT')
      return transferred
        ? { disposition: 'retained', resource: transferred, reason: 'ownership_transferred' }
        : { disposition: 'retained', resource: null, reason: 'no_owned_resource' }
    }
    if (resource.release_state === 'released' || resource.ownership_state === 'released') {
      this.db.exec('COMMIT')
      return { disposition: 'already_released', resource }
    }
    if (worker.state === 'stopped' || worker.state === 'abandoned') {
      this.db.exec('COMMIT')
      return { disposition: 'retained', resource, reason: 'identity_unproven' }
    }
    if (resource.ownership_state === 'external') {
      this.db.exec('COMMIT')
      return {
        disposition: 'retained',
        resource,
        reason: (resource.retained_reason as WorkerTerminalRetainedReason) ?? 'external_terminal'
      }
    }
    if (resource.ownership_state === 'user_owned') {
      this.db.exec('COMMIT')
      return { disposition: 'retained', resource, reason: 'user_takeover' }
    }
    if (resource.ownership_state === 'transferred') {
      this.db.exec('COMMIT')
      return { disposition: 'retained', resource, reason: 'ownership_transferred' }
    }
    if (resource.release_state === 'retained' && resource.retained_reason === 'user_requested') {
      this.db.prepare('DELETE FROM worker_terminal_archives WHERE dispatch_id = ?').run(dispatchId)
    }
    this.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET release_state = CASE
               WHEN release_state = 'releasing' THEN 'releasing'
               ELSE 'requested'
             END,
             retained_reason = NULL,
             release_requested_at = COALESCE(release_requested_at, datetime('now')),
             release_error = NULL, updated_at = datetime('now')
         WHERE id = ? AND release_state IN ('not_requested', 'retained', 'requested', 'releasing', 'unknown')`
      )
      .run(resource.id)
    this.db.exec('COMMIT')
    return {
      disposition: 'requested',
      resource: this.getWorkerTerminalResource(resource.id) as WorkerTerminalResourceRow
    }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function settleDeadWorkerTerminalRelease(
  this: OrchestrationDb,
  params: {
    requestingDispatchId: string
    resourceId: string
    processIncarnation: string
  }
):
  | { disposition: 'released'; resource: WorkerTerminalResourceRow }
  | { disposition: 'retained'; resource: WorkerTerminalResourceRow } {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const resource = this.getWorkerTerminalResource(params.resourceId)
    if (!resource) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Worker terminal resource ${params.resourceId} was not found.`
      )
    }
    const priorOwners = parseWorkerTerminalPriorOwnerIds(resource.prior_owner_dispatch_ids)
    const requesterRelated =
      resource.owner_dispatch_id === params.requestingDispatchId ||
      priorOwners?.includes(params.requestingDispatchId) === true
    const requester = this.getWorkerDispatch(params.requestingDispatchId)
    const owner = this.getWorkerDispatch(resource.owner_dispatch_id)
    const requesterSettled = Boolean(requester && WORKER_SETTLED_STATES.includes(requester.state))
    const ownerSettled = Boolean(owner && WORKER_SETTLED_STATES.includes(owner.state))
    if (
      !priorOwners ||
      !requesterRelated ||
      !requesterSettled ||
      !ownerSettled ||
      resource.process_incarnation !== params.processIncarnation ||
      resource.ownership_state === 'released' ||
      !['not_requested', 'retained', 'unknown'].includes(resource.release_state)
    ) {
      this.db.exec('COMMIT')
      return { disposition: 'retained', resource }
    }
    this.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET release_state = 'released', ownership_state = 'released', retained_reason = NULL,
             release_requested_at = COALESCE(release_requested_at, datetime('now')),
             release_completed_at = datetime('now'), release_error = NULL,
             updated_at = datetime('now')
         WHERE id = ? AND process_incarnation = ? AND ownership_state != 'released'
           AND release_state IN ('not_requested', 'retained', 'unknown')`
      )
      .run(params.resourceId, params.processIncarnation)
    const released = this.getWorkerTerminalResource(params.resourceId) as WorkerTerminalResourceRow
    this.db.exec('COMMIT')
    return released.release_state === 'released'
      ? { disposition: 'released', resource: released }
      : { disposition: 'retained', resource: released }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type WorkerTerminalReleaseMethods = {
  requestWorkerTerminalRelease: typeof requestWorkerTerminalRelease
  settleDeadWorkerTerminalRelease: typeof settleDeadWorkerTerminalRelease
}

export function attachWorkerTerminalRelease(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    requestWorkerTerminalRelease,
    settleDeadWorkerTerminalRelease
  })
}
