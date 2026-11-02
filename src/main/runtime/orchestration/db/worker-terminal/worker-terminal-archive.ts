import {
  USER_KEPT_WORKER_TERMINAL_SQL,
  type WorkerTerminalArchiveKind,
  type WorkerTerminalResourceRow,
  type WorkerTerminalArchiveRow,
  type WorkerTerminalArchiveStatus,
  type WorkerTerminalRetainedReason
} from '../../worker-terminal-ownership'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

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

/** Stop closes the terminal; keep its output so a later release has an archive to settle with. */
export function storeWorkerTerminalArchiveBeforeStop(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    resourceId: string
    kind: WorkerTerminalArchiveKind
    content: string
    archiveSource: 'transcript' | 'terminal'
    archiveStatus: Extract<WorkerTerminalArchiveStatus, 'captured' | 'empty'>
  }
): void {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const { changes } = this.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET archive_source = ?, archive_status = ?, updated_at = datetime('now')
         WHERE id = ? AND owner_dispatch_id = ? AND ownership_state = 'owned'
           AND release_state IN ('not_requested', 'retained')`
      )
      .run(params.archiveSource, params.archiveStatus, params.resourceId, params.dispatchId)
    if (changes > 0) {
      this.storeWorkerTerminalArchive(params)
    }
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
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
  resourceId: string
): WorkerTerminalResourceRow {
  this.db
    .prepare(
      `UPDATE worker_terminal_resources
       SET release_state = 'released', ownership_state = 'released',
           release_completed_at = datetime('now'), release_error = NULL,
           updated_at = datetime('now')
       WHERE id = ? AND release_state IN ('requested', 'releasing', 'unknown')`
    )
    .run(resourceId)
  return this.getWorkerTerminalResource(resourceId) as WorkerTerminalResourceRow
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
       SET release_state = 'retained', retained_reason = ?, updated_at = datetime('now')
       WHERE id = ? AND release_state IN ('requested', 'releasing')`
    )
    .run(reason, resourceId)
  return this.getWorkerTerminalResource(resourceId) as WorkerTerminalResourceRow
}

/** Caller owns the transaction; retain must preserve committed release state and its output archive. */
export function retainTerminalResourceInTransaction(
  database: OrchestrationDb,
  resourceId: string,
  dispatchId: string,
  retainableSql = "release_state IN ('not_requested', 'retained', 'requested')",
  reason: Extract<WorkerTerminalRetainedReason, 'user_requested' | 'user_kept'> = 'user_requested'
): boolean {
  const { changes } = database.db
    .prepare(
      `UPDATE worker_terminal_resources
       SET retained_reason = CASE WHEN ${USER_KEPT_WORKER_TERMINAL_SQL} THEN retained_reason ELSE ? END,
           release_state = 'retained', auto_release_at = NULL, updated_at = datetime('now')
       WHERE id = ? AND ${retainableSql}`
    )
    .run(reason, resourceId)
  if (changes > 0) {
    // A stopped worker's terminal is closed; the archive taken before stop is its only output.
    const dropped = database.db
      .prepare(
        `DELETE FROM worker_terminal_archives WHERE dispatch_id = ? AND NOT EXISTS (
           SELECT 1 FROM worker_dispatches WHERE dispatch_id = ? AND state = 'stopped')`
      )
      .run(dispatchId, dispatchId)
    if (dropped.changes > 0) {
      database.db
        .prepare(
          'UPDATE worker_terminal_resources SET archive_source = NULL, archive_status = NULL WHERE id = ?'
        )
        .run(resourceId)
    }
  }
  return changes > 0
}

type WorkerTerminalRetainResult =
  | { disposition: 'retained'; resource: WorkerTerminalResourceRow }
  | { disposition: 'already_released'; resource: WorkerTerminalResourceRow }
  | { disposition: 'release_committed'; resource: WorkerTerminalResourceRow }
  | { disposition: 'no_owned_resource'; resource: null }

export function retainWorkerTerminalResource(
  this: OrchestrationDb,
  dispatchId: string
): WorkerTerminalRetainResult {
  return retainOwnedTerminalResource(this, dispatchId, () => {
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
  })
}

/** The execution host's half of a forwarded worker-keep-open. */
export function retainRemoteAttachmentTerminalResource(
  this: OrchestrationDb,
  dispatchId: string
): WorkerTerminalRetainResult {
  return retainOwnedTerminalResource(this, dispatchId, () => {
    if (!this.getRemoteDispatchAttachment(dispatchId)) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Remote Dispatch ${dispatchId} was not found.`
      )
    }
  })
}

function retainOwnedTerminalResource(
  database: OrchestrationDb,
  dispatchId: string,
  assertRetainable: () => void
): WorkerTerminalRetainResult {
  database.db.exec('BEGIN IMMEDIATE')
  try {
    assertRetainable()
    const resource = database.getWorkerTerminalResourceByOwner(dispatchId)
    if (!resource) {
      database.db.exec('COMMIT')
      return { disposition: 'no_owned_resource', resource: null }
    }
    if (resource.release_state === 'released') {
      database.db.exec('COMMIT')
      return { disposition: 'already_released', resource }
    }
    const retained = retainTerminalResourceInTransaction(database, resource.id, dispatchId)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row was read under this transaction's write lock, so it still exists.
    const updated = database.getWorkerTerminalResource(resource.id) as WorkerTerminalResourceRow
    database.db.exec('COMMIT')
    return retained
      ? { disposition: 'retained', resource: updated }
      : { disposition: 'release_committed', resource: updated }
  } catch (error) {
    database.db.exec('ROLLBACK')
    throw error
  }
}

export type WorkerTerminalArchiveMethods = {
  storeWorkerTerminalArchive: typeof storeWorkerTerminalArchive
  storeWorkerTerminalArchiveBeforeStop: typeof storeWorkerTerminalArchiveBeforeStop
  commitWorkerTerminalArchiveForRelease: typeof commitWorkerTerminalArchiveForRelease
  getWorkerTerminalArchive: typeof getWorkerTerminalArchive
  settleWorkerTerminalRelease: typeof settleWorkerTerminalRelease
  markWorkerTerminalReleaseUnknown: typeof markWorkerTerminalReleaseUnknown
  revertWorkerTerminalReleaseToRetained: typeof revertWorkerTerminalReleaseToRetained
  retainWorkerTerminalResource: typeof retainWorkerTerminalResource
  retainRemoteAttachmentTerminalResource: typeof retainRemoteAttachmentTerminalResource
}

export function attachWorkerTerminalArchive(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    storeWorkerTerminalArchive,
    storeWorkerTerminalArchiveBeforeStop,
    commitWorkerTerminalArchiveForRelease,
    getWorkerTerminalArchive,
    settleWorkerTerminalRelease,
    markWorkerTerminalReleaseUnknown,
    revertWorkerTerminalReleaseToRetained,
    retainWorkerTerminalResource,
    retainRemoteAttachmentTerminalResource
  })
}
