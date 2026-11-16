import {
  decideWorkerTerminalRelease,
  WORKER_SETTLED_STATES,
  WORKER_TERMINAL_RELEASABLE_ROW_SQL
} from '../../terminal-authority/release/worker-terminal-ownership'
import type {
  WorkerTerminalArchiveKind,
  WorkerTerminalArchiveStatus,
  WorkerTerminalResourceRow,
  WorkerTerminalRetainedReason
} from '../../terminal-authority/release/worker-terminal-ownership'
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
      // Release is post-completion cleanup; uncertain workers must not be closed before coordinator review.
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
    const decision = decideWorkerTerminalRelease(resource)
    if (decision.action === 'already_released') {
      this.db.exec('COMMIT')
      return { disposition: 'already_released', resource }
    }
    if (worker.state === 'stopped' || worker.state === 'abandoned') {
      this.db.exec('COMMIT')
      return { disposition: 'retained', resource, reason: 'identity_unproven' }
    }
    if (decision.action === 'retained') {
      this.db.exec('COMMIT')
      return { disposition: 'retained', resource, reason: decision.reason }
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
             retained_reason = NULL, auto_release_at = NULL,
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

/** Settle a resource whose exact process is proven gone, recording where its output lives if nothing has yet. */
export function settleDeadWorkerTerminalRelease(
  this: OrchestrationDb,
  params: {
    requestingDispatchId: string
    resourceId: string
    processIncarnation: string
    /** The row the caller saw before its awaited proof; any change since voids that proof's intent. */
    expected: Pick<
      WorkerTerminalResourceRow,
      'owner_dispatch_id' | 'host_scope' | 'release_state' | 'retained_reason'
    >
    /** Where the output lives, read from this transaction's row; called only when the owner has no archive yet. */
    output: (resource: WorkerTerminalResourceRow) => {
      kind: WorkerTerminalArchiveKind
      content: string
      archiveSource: string
      archiveStatus: WorkerTerminalArchiveStatus
    }
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
    const { expected } = params
    const unchanged =
      resource.owner_dispatch_id === expected.owner_dispatch_id &&
      resource.host_scope === expected.host_scope &&
      resource.release_state === expected.release_state &&
      resource.retained_reason === expected.retained_reason
    const archive = this.getWorkerTerminalArchive(resource.owner_dispatch_id)
    // Only the owner records a new reference; a prior owner settles only output already recorded.
    const recordsOutput = !archive && resource.owner_dispatch_id === params.requestingDispatchId
    if (
      !priorOwners ||
      !requesterRelated ||
      !requesterSettled ||
      !ownerSettled ||
      !unchanged ||
      resource.process_incarnation !== params.processIncarnation ||
      (archive ? archive.resource_id !== resource.id : !recordsOutput) ||
      decideWorkerTerminalRelease(resource).action !== 'proceed'
    ) {
      this.db.exec('COMMIT')
      return { disposition: 'retained', resource }
    }
    const output = recordsOutput ? params.output(resource) : null
    if (output) {
      this.storeWorkerTerminalArchive({
        dispatchId: resource.owner_dispatch_id,
        resourceId: resource.id,
        kind: output.kind,
        content: output.content
      })
    }
    this.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET release_state = 'released', ownership_state = 'released', retained_reason = NULL,
             archive_source = COALESCE(?, archive_source),
             archive_status = COALESCE(?, archive_status),
             release_requested_at = COALESCE(release_requested_at, datetime('now')),
             release_completed_at = datetime('now'), release_error = NULL,
             updated_at = datetime('now')
         WHERE id = ? AND process_incarnation = ? AND ${WORKER_TERMINAL_RELEASABLE_ROW_SQL}`
      )
      .run(
        output?.archiveSource ?? null,
        output?.archiveStatus ?? null,
        params.resourceId,
        params.processIncarnation
      )
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
