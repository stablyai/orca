import {
  decideWorkerTerminalRelease,
  WORKER_SETTLED_STATES,
  WORKER_TERMINAL_RELEASABLE_ROW_SQL,
  type WorkerTerminalResourceRow,
  type WorkerTerminalRetainedReason
} from '../../worker-terminal-ownership'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

export function requestRemoteAttachmentTerminalRelease(
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
    const attachment = this.getRemoteDispatchAttachment(dispatchId)
    if (!attachment) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Remote Dispatch ${dispatchId} was not found.`
      )
    }
    if (!WORKER_SETTLED_STATES.includes(attachment.state)) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Remote Dispatch ${dispatchId} is ${attachment.state}; only a settled worker can release. Use worker-stop to cancel an active worker.`
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
    const decision = decideWorkerTerminalRelease(resource)
    if (decision.action === 'already_released') {
      this.db.exec('COMMIT')
      return { disposition: 'already_released', resource }
    }
    if (attachment.state === 'stopped' || attachment.state === 'abandoned') {
      this.db.exec('COMMIT')
      return { disposition: 'retained', resource, reason: 'identity_unproven' }
    }
    if (decision.action === 'retained') {
      this.db.exec('COMMIT')
      return { disposition: 'retained', resource, reason: decision.reason }
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
         WHERE id = ? AND ${WORKER_TERMINAL_RELEASABLE_ROW_SQL}`
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

export type RemoteDispatchAttachmentReleaseMethods = {
  requestRemoteAttachmentTerminalRelease: typeof requestRemoteAttachmentTerminalRelease
}

export function attachRemoteDispatchAttachmentRelease(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { requestRemoteAttachmentTerminalRelease })
}
