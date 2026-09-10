import type {
  WorkerTerminalArchiveKind,
  WorkerTerminalResourceRow,
  WorkerTerminalArchiveRow,
  WorkerTerminalArchiveStatus,
  WorkerTerminalRetainedReason
} from '../../worker-terminal-ownership'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import {
  markLinkedWorkerLeaseReleased,
  markLinkedWorkerLeaseReleaseUnknown,
  retainLinkedWorkerLease
} from './worker-terminal-lease-lifecycle'

export function storeWorkerTerminalArchive(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    resourceId: string
    kind: WorkerTerminalArchiveKind
    content: string
  }
): void {
  this.db
    .prepare(
      `INSERT INTO worker_terminal_archives (dispatch_id, resource_id, kind, content)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(dispatch_id) DO UPDATE SET
         resource_id = excluded.resource_id, kind = excluded.kind, content = excluded.content`
    )
    .run(params.dispatchId, params.resourceId, params.kind, params.content)
}

export function commitWorkerTerminalArchiveForRelease(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    resourceId: string
    kind?: WorkerTerminalArchiveKind
    content?: string
    archiveSource: 'transcript' | 'terminal'
    archiveStatus: Extract<WorkerTerminalArchiveStatus, 'captured' | 'empty'>
  }
): WorkerTerminalResourceRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const resource = this.getWorkerTerminalResource(params.resourceId)
    if (!resource) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Worker terminal resource ${params.resourceId} was not found.`
      )
    }
    if (
      resource.owner_dispatch_id === params.dispatchId &&
      resource.ownership_state === 'owned' &&
      resource.release_state === 'requested'
    ) {
      if (params.kind && params.content !== undefined) {
        this.storeWorkerTerminalArchive({
          dispatchId: params.dispatchId,
          resourceId: params.resourceId,
          kind: params.kind,
          content: params.content
        })
      }
      const archive = this.getWorkerTerminalArchive(params.dispatchId)
      if (!archive || archive.resource_id !== params.resourceId) {
        throw new OrchestrationError(
          'archive_failed',
          `Output could not be preserved for Dispatch ${params.dispatchId}; the terminal was retained.`
        )
      }
      this.db
        .prepare(
          `UPDATE worker_terminal_resources
           SET release_state = 'releasing', archive_source = ?, archive_status = ?,
               updated_at = datetime('now')
           WHERE id = ? AND owner_dispatch_id = ? AND ownership_state = 'owned'
             AND release_state = 'requested'`
        )
        .run(params.archiveSource, params.archiveStatus, params.resourceId, params.dispatchId)
    }
    const updated = this.getWorkerTerminalResource(params.resourceId) as WorkerTerminalResourceRow
    this.db.exec('COMMIT')
    return updated
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function getWorkerTerminalArchive(
  this: OrchestrationDb,
  dispatchId: string
): WorkerTerminalArchiveRow | undefined {
  return this.db
    .prepare('SELECT * FROM worker_terminal_archives WHERE dispatch_id = ?')
    .get(dispatchId) as WorkerTerminalArchiveRow | undefined
}

export function settleWorkerTerminalRelease(
  this: OrchestrationDb,
  params: {
    resourceId: string
    ownerDispatchId: string
    processIncarnation: string
  }
): WorkerTerminalResourceRow {
  const update = this.db
    .prepare(
      `UPDATE worker_terminal_resources
       SET release_state = 'released', ownership_state = 'released',
           retained_reason = NULL, retention_owner = NULL, retention_expires_at = NULL,
           review_id = NULL,
           release_completed_at = datetime('now'), release_error = NULL,
           updated_at = datetime('now')
       WHERE id = ? AND owner_dispatch_id = ? AND process_incarnation = ?
         AND release_state IN ('requested', 'releasing', 'unknown')`
    )
    .run(params.resourceId, params.ownerDispatchId, params.processIncarnation)
  const settled = this.getWorkerTerminalResource(params.resourceId) as WorkerTerminalResourceRow
  if (
    update.changes > 0 &&
    settled.owner_dispatch_id === params.ownerDispatchId &&
    settled.process_incarnation === params.processIncarnation
  ) {
    markLinkedWorkerLeaseReleased(this, params.resourceId)
  }
  return settled
}

export function markWorkerTerminalReleaseUnknown(
  this: OrchestrationDb,
  resourceId: string,
  reason: string
): WorkerTerminalResourceRow {
  this.db
    .prepare(
      `UPDATE worker_terminal_resources
       SET release_state = 'unknown', release_error = ?, updated_at = datetime('now')
       WHERE id = ? AND release_state IN ('requested', 'releasing')`
    )
    .run(reason, resourceId)
  markLinkedWorkerLeaseReleaseUnknown(this, resourceId)
  return this.getWorkerTerminalResource(resourceId) as WorkerTerminalResourceRow
}

export function revertWorkerTerminalReleaseToRetained(
  this: OrchestrationDb,
  resourceId: string,
  reason: WorkerTerminalRetainedReason
): WorkerTerminalResourceRow {
  this.db
    .prepare(
      `UPDATE worker_terminal_resources
       SET release_state = 'retained', retained_reason = ?, retention_owner = NULL,
           retention_expires_at = NULL, review_id = NULL, updated_at = datetime('now')
       WHERE id = ? AND release_state IN ('requested', 'releasing')`
    )
    .run(reason, resourceId)
  retainLinkedWorkerLease(this, resourceId)
  return this.getWorkerTerminalResource(resourceId) as WorkerTerminalResourceRow
}

export function retainWorkerTerminalResource(
  this: OrchestrationDb,
  dispatchId: string
):
  | { disposition: 'retained'; resource: WorkerTerminalResourceRow }
  | { disposition: 'already_released'; resource: WorkerTerminalResourceRow }
  | { disposition: 'release_committed'; resource: WorkerTerminalResourceRow }
  | { disposition: 'no_owned_resource'; resource: null } {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(dispatchId)
    if (!dispatch) {
      throw new OrchestrationError('dispatch_not_found', `Dispatch ${dispatchId} was not found.`)
    }
    const worker = this.getWorkerDispatch(dispatchId)
    if (!worker && !['completed', 'failed', 'circuit_broken'].includes(dispatch.status)) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${dispatchId} is ${dispatch.status}; only a settled dispatch can retain.`
      )
    }
    const resource = this.getWorkerTerminalResourceByOwner(dispatchId)
    if (!resource) {
      this.db.exec('COMMIT')
      return { disposition: 'no_owned_resource', resource: null }
    }
    if (resource.release_state === 'released') {
      this.db.exec('COMMIT')
      return { disposition: 'already_released', resource }
    }
    this.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET release_state = 'retained', retained_reason = 'user_requested',
             retention_owner = NULL, retention_expires_at = NULL, review_id = NULL,
             updated_at = datetime('now')
         WHERE id = ? AND release_state IN (
           'not_requested', 'retained', 'retained_for_review', 'requested'
         )`
      )
      .run(resource.id)
    const updated = this.getWorkerTerminalResource(resource.id) as WorkerTerminalResourceRow
    if (updated.release_state !== 'retained') {
      this.db.exec('COMMIT')
      return { disposition: 'release_committed', resource: updated }
    }
    this.db.prepare('DELETE FROM worker_terminal_archives WHERE dispatch_id = ?').run(dispatchId)
    retainLinkedWorkerLease(this, resource.id)
    this.db.exec('COMMIT')
    return { disposition: 'retained', resource: updated }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function retainWorkerTerminalResourceForReview(
  this: OrchestrationDb,
  dispatchId: string,
  retention: { owner: string; reason: string; expiresAt: string; reviewId: string }
): WorkerTerminalResourceRow {
  const fields = [retention.owner, retention.reason, retention.expiresAt, retention.reviewId]
  if (fields.some((field) => !field.trim()) || !Number.isFinite(Date.parse(retention.expiresAt))) {
    throw new OrchestrationError(
      'task_not_startable',
      'Review retention requires an owner, reason, valid expiry, and review ID.'
    )
  }
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const resource = this.getWorkerTerminalResourceByOwner(dispatchId)
    if (!resource) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Dispatch ${dispatchId} has no worker terminal resource to retain for review.`
      )
    }
    if (resource.release_state === 'released' || resource.ownership_state === 'released') {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Released worker terminal resource ${resource.id} cannot be retained for review.`
      )
    }
    this.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET release_state = 'retained_for_review', retained_reason = ?, retention_owner = ?,
             retention_expires_at = ?, review_id = ?, updated_at = datetime('now')
         WHERE id = ? AND release_state IN (
           'not_requested', 'retained', 'retained_for_review', 'requested', 'unknown'
         )`
      )
      .run(
        retention.reason.trim(),
        retention.owner.trim(),
        new Date(retention.expiresAt).toISOString(),
        retention.reviewId.trim(),
        resource.id
      )
    const retained = this.getWorkerTerminalResource(resource.id) as WorkerTerminalResourceRow
    if (retained.release_state !== 'retained_for_review') {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Worker terminal resource ${resource.id} has committed release work.`
      )
    }
    retainLinkedWorkerLease(this, resource.id)
    this.db.exec('COMMIT')
    return retained
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type WorkerTerminalArchiveMethods = {
  storeWorkerTerminalArchive: typeof storeWorkerTerminalArchive
  commitWorkerTerminalArchiveForRelease: typeof commitWorkerTerminalArchiveForRelease
  getWorkerTerminalArchive: typeof getWorkerTerminalArchive
  settleWorkerTerminalRelease: typeof settleWorkerTerminalRelease
  markWorkerTerminalReleaseUnknown: typeof markWorkerTerminalReleaseUnknown
  revertWorkerTerminalReleaseToRetained: typeof revertWorkerTerminalReleaseToRetained
  retainWorkerTerminalResource: typeof retainWorkerTerminalResource
  retainWorkerTerminalResourceForReview: typeof retainWorkerTerminalResourceForReview
}

export function attachWorkerTerminalArchive(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    storeWorkerTerminalArchive,
    commitWorkerTerminalArchiveForRelease,
    getWorkerTerminalArchive,
    settleWorkerTerminalRelease,
    markWorkerTerminalReleaseUnknown,
    revertWorkerTerminalReleaseToRetained,
    retainWorkerTerminalResource,
    retainWorkerTerminalResourceForReview
  })
}
