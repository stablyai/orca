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
import { isStructuredWorkerHandle } from '../../../../../shared/orchestration/workers/structured-worker-handle'
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

type DeadWorkerTerminalRelease = {
  requestingDispatchId: string
  resourceId: string
  processIncarnation: string
}

/** Where a proven-exited worker's output lives, read from the row inside the settling transaction. */
type DeadWorkerTerminalOutput = {
  kind: WorkerTerminalArchiveKind
  content: string
  archiveSource: string
  archiveStatus: WorkerTerminalArchiveStatus
}

type ProvenExitedWorkerTerminalRelease = DeadWorkerTerminalRelease & {
  /** The row the caller saw before its awaited proof; any change since voids that proof's intent. */
  expected: Pick<
    WorkerTerminalResourceRow,
    'owner_dispatch_id' | 'host_scope' | 'release_state' | 'retained_reason'
  >
  /** Called only when the owner itself settles and has no archive yet. */
  output: (resource: WorkerTerminalResourceRow) => DeadWorkerTerminalOutput
}

/** Settle a resource whose exact process is proven gone, recording where its output lives if nothing has yet. */
export function settleDeadWorkerTerminalRelease(
  this: OrchestrationDb,
  params: ProvenExitedWorkerTerminalRelease
):
  | { disposition: 'released'; resource: WorkerTerminalResourceRow }
  | { disposition: 'retained'; resource: WorkerTerminalResourceRow } {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const resource = releaseDeadWorkerTerminalInTransaction(this, params)
    this.db.exec('COMMIT')
    return resource.release_state === 'released'
      ? { disposition: 'released', resource }
      : { disposition: 'retained', resource }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

/** Releases a settled worker's own, never-requested terminal once its process is proven gone. */
export function releaseExitedWorkerTerminalInTransaction(
  database: OrchestrationDb,
  dispatchId: string
): void {
  const resource = database.getWorkerTerminalResourceByOwner(dispatchId)
  if (
    resource?.release_state === 'not_requested' &&
    resource.process_incarnation &&
    // A chat worker's history stays readable through its unreleased row until a reference is saved.
    (!isStructuredWorkerHandle(resource.terminal_handle) ||
      database.hasWorkerTerminalArchive(dispatchId))
  ) {
    releaseDeadWorkerTerminalInTransaction(database, {
      requestingDispatchId: dispatchId,
      resourceId: resource.id,
      processIncarnation: resource.process_incarnation
    })
  }
}

/** One transaction, so a sweep's page wakes Crew readers once rather than once per row. */
export function settleDeadWorkerTerminalReleases(
  this: OrchestrationDb,
  releases: readonly DeadWorkerTerminalRelease[]
): number {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const released = releases.filter(
      (release) =>
        // A retain or release request since the sweep read the row wins over the sweep.
        this.getWorkerTerminalResource(release.resourceId)?.release_state === 'not_requested' &&
        releaseDeadWorkerTerminalInTransaction(this, release).release_state === 'released'
    ).length
    this.db.exec('COMMIT')
    return released
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

/** Marks a resource whose process is proven gone released, inside the caller's transaction. */
export function releaseDeadWorkerTerminalInTransaction(
  database: OrchestrationDb,
  params: DeadWorkerTerminalRelease | ProvenExitedWorkerTerminalRelease
): WorkerTerminalResourceRow {
  const resource = database.getWorkerTerminalResource(params.resourceId)
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
  const requester = database.getWorkerDispatch(params.requestingDispatchId)
  const owner = database.getWorkerDispatch(resource.owner_dispatch_id)
  const requesterSettled = Boolean(requester && WORKER_SETTLED_STATES.includes(requester.state))
  const ownerSettled = Boolean(owner && WORKER_SETTLED_STATES.includes(owner.state))
  // Exit proves process death, not a recorded output location; require one whenever recording is reachable.
  // Capture runs only while requested; an unrequested or retained owner settles unavailable instead.
  // Identity only: the saved output can be large and is never needed here.
  const archive = database.db
    .prepare('SELECT resource_id FROM worker_terminal_archives WHERE dispatch_id = ?')
    .get(resource.owner_dispatch_id)
  const isOwner = resource.owner_dispatch_id === params.requestingDispatchId
  // A proven-exit settle records output from saved state, whatever the request state; only the owner may.
  const deriveOutput = 'output' in params ? params.output : null
  const recordsOutput = !archive && isOwner && deriveOutput !== null
  const archiveUnreachable =
    recordsOutput ||
    (isOwner &&
      (resource.release_state === 'not_requested' || resource.release_state === 'retained'))
  const expected = 'expected' in params ? params.expected : null
  const unchanged =
    !expected ||
    (resource.owner_dispatch_id === expected.owner_dispatch_id &&
      resource.host_scope === expected.host_scope &&
      resource.release_state === expected.release_state &&
      resource.retained_reason === expected.retained_reason)
  if (
    !priorOwners ||
    !requesterRelated ||
    !requesterSettled ||
    !ownerSettled ||
    !unchanged ||
    resource.process_incarnation !== params.processIncarnation ||
    (archive ? archive.resource_id !== resource.id : !archiveUnreachable) ||
    decideWorkerTerminalRelease(resource).action !== 'proceed'
  ) {
    return resource
  }
  const output = recordsOutput ? deriveOutput(resource) : null
  if (output) {
    database.storeWorkerTerminalArchive({
      dispatchId: resource.owner_dispatch_id,
      resourceId: resource.id,
      kind: output.kind,
      content: output.content
    })
  }
  database.db
    .prepare(
      `UPDATE worker_terminal_resources
       SET release_state = 'released', ownership_state = 'released', retained_reason = NULL,
           auto_release_at = NULL, archive_source = COALESCE(?, archive_source),
           archive_status = COALESCE(?, archive_status),
           release_requested_at = COALESCE(release_requested_at, datetime('now')),
           release_completed_at = datetime('now'), release_error = NULL,
           updated_at = datetime('now')
       WHERE id = ? AND process_incarnation = ? AND ${WORKER_TERMINAL_RELEASABLE_ROW_SQL}`
    )
    .run(
      output?.archiveSource ?? null,
      output?.archiveStatus ??
        (archive ? null : ('unavailable' satisfies WorkerTerminalArchiveStatus)),
      params.resourceId,
      params.processIncarnation
    )
  return database.getWorkerTerminalResource(params.resourceId) ?? resource
}

/** Rows a release sweep could ever act on; kept in a partial index so legacy history is never read. */
export const UNRELEASED_MINTED_WORKER_TERMINAL_SQL = `release_state = 'not_requested'
  AND ownership_state = 'owned'
  AND process_incarnation LIKE '%:________-____-____-____-____________'
  AND terminal_handle NOT LIKE 'structworker\\_%' ESCAPE '\\'`

/**
 * One page of minted, never-requested terminal (not chat) worker rows, in owner order. `eligible` marks
 * the ones whose worker settled before `updatedBefore`: older builds left these owned, pinning their Run.
 */
export function listSettledWorkerTerminalsStillOwned(
  this: OrchestrationDb,
  afterOwnerDispatchId: string,
  limit: number,
  updatedBefore: string
): (WorkerTerminalResourceRow & { eligible: number })[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: res.* plus its eligibility.
  return this.db
    .prepare(
      // Pages on the partial index's own key, so each page reads at most `limit` entries; legacy fences
      // never enter the index.
      `SELECT res.*,
          (w.state IN ('succeeded', 'failed', 'stopped', 'abandoned') AND res.updated_at < ?) AS eligible
        FROM (
          SELECT * FROM worker_terminal_resources
            INDEXED BY idx_worker_terminal_resources_unreleased_minted
            WHERE ${UNRELEASED_MINTED_WORKER_TERMINAL_SQL} AND owner_dispatch_id > ?
            ORDER BY owner_dispatch_id LIMIT ?
        ) res
        LEFT JOIN worker_dispatches w ON w.dispatch_id = res.owner_dispatch_id
        ORDER BY res.owner_dispatch_id`
    )
    .all(updatedBefore, afterOwnerDispatchId, limit) as (WorkerTerminalResourceRow & {
    eligible: number
  })[]
}

export type WorkerTerminalReleaseMethods = {
  requestWorkerTerminalRelease: typeof requestWorkerTerminalRelease
  settleDeadWorkerTerminalRelease: typeof settleDeadWorkerTerminalRelease
  settleDeadWorkerTerminalReleases: typeof settleDeadWorkerTerminalReleases
  listSettledWorkerTerminalsStillOwned: typeof listSettledWorkerTerminalsStillOwned
}

export function attachWorkerTerminalRelease(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    requestWorkerTerminalRelease,
    settleDeadWorkerTerminalRelease,
    settleDeadWorkerTerminalReleases,
    listSettledWorkerTerminalsStillOwned
  })
}
