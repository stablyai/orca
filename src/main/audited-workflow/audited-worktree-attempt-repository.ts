// Persistence and CAS for audited_worktree_attempts.
//
// Registry publication/release is performed INSIDE the same synchronous block as
// the SQLite commit. node:sqlite's DatabaseSync is fully synchronous, so no
// await can interleave — there is no instant at which an attempt is durable but
// its path unguarded (or released but still guarded).
import { randomBytes } from 'node:crypto'
import type Database from '../sqlite/sync-database'
import {
  REGISTRY_GUARDED_ATTEMPT_STATUSES,
  type WorktreeAttemptStatus,
  type WorktreeReasonCode
} from '../../shared/audited-worktree-types'
import {
  markAuditedWorktreeRegistryUnavailable,
  publishAuditedWorktreePath,
  rebuildAuditedWorktreeRegistry,
  releaseAuditedWorktreePath
} from './audited-worktree-registry'

export type AuditedWorktreeAttemptRow = {
  id: string
  taskId: string
  status: WorktreeAttemptStatus
  intendedBranch: string
  intendedPath: string
  intendedBaseCommit: string
  intendedCommonDir: string
  provenanceId: string
  reasonCode: WorktreeReasonCode | null
  claimedAt: number
  createdAt: number | null
  finalizedAt: number | null
}

const LIVE_STATUSES: readonly WorktreeAttemptStatus[] = ['claimed', 'created', 'verified']

function generateAttemptId(): string {
  return `wtattempt_${randomBytes(8).toString('hex')}`
}

function mapRow(row: Record<string, unknown>): AuditedWorktreeAttemptRow {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    status: row.status as WorktreeAttemptStatus,
    intendedBranch: row.intended_branch as string,
    intendedPath: row.intended_path as string,
    intendedBaseCommit: row.intended_base_commit as string,
    intendedCommonDir: row.intended_common_dir as string,
    provenanceId: row.provenance_id as string,
    reasonCode: (row.reason_code as WorktreeReasonCode | null) ?? null,
    claimedAt: row.claimed_at_ms as number,
    createdAt: (row.created_at_ms as number | null) ?? null,
    finalizedAt: (row.finalized_at_ms as number | null) ?? null
  }
}

export function getLiveAttempt(
  db: Database.Database,
  taskId: string
): AuditedWorktreeAttemptRow | null {
  const placeholders = LIVE_STATUSES.map(() => '?').join(', ')
  const row = db
    .prepare(
      `SELECT * FROM audited_worktree_attempts WHERE task_id = ? AND status IN (${placeholders})`
    )
    .get(taskId, ...LIVE_STATUSES) as Record<string, unknown> | undefined
  return row ? mapRow(row) : null
}

/**
 * The most recent attempt for a task regardless of status. Recovery admission
 * depends on this durable state, not on the displayed reason code — the same
 * code can arise both before a claim (safe) and after a successful worktree-add
 * (unsafe).
 */
export function getLatestAttempt(
  db: Database.Database,
  taskId: string
): AuditedWorktreeAttemptRow | null {
  const row = db
    .prepare(
      `SELECT * FROM audited_worktree_attempts WHERE task_id = ?
        ORDER BY claimed_at_ms DESC, rowid DESC LIMIT 1`
    )
    .get(taskId) as Record<string, unknown> | undefined
  return row ? mapRow(row) : null
}

/**
 * True when a task has surviving evidence that must never be re-claimed: an
 * ambiguous failure leaves real Git state (branch/admin/directory) on disk that
 * Phase 3 never cleans automatically.
 */
export function hasBlockingAttemptEvidence(db: Database.Database, taskId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM audited_worktree_attempts WHERE task_id = ? AND status = 'failed_ambiguous' LIMIT 1`
    )
    .get(taskId)
  return row !== undefined
}

export function getAttemptById(
  db: Database.Database,
  attemptId: string
): AuditedWorktreeAttemptRow | null {
  const row = db.prepare(`SELECT * FROM audited_worktree_attempts WHERE id = ?`).get(attemptId) as
    | Record<string, unknown>
    | undefined
  return row ? mapRow(row) : null
}

export function listGuardedAttempts(db: Database.Database): AuditedWorktreeAttemptRow[] {
  const placeholders = REGISTRY_GUARDED_ATTEMPT_STATUSES.map(() => '?').join(', ')
  const rows = db
    .prepare(`SELECT * FROM audited_worktree_attempts WHERE status IN (${placeholders})`)
    .all(...REGISTRY_GUARDED_ATTEMPT_STATUSES) as Record<string, unknown>[]
  return rows.map(mapRow)
}

export type ClaimAttemptArgs = {
  taskId: string
  intendedBranch: string
  intendedPath: string
  intendedBaseCommit: string
  intendedCommonDir: string
  provenanceId: string
}

export type ClaimAttemptResult =
  | { ok: true; attempt: AuditedWorktreeAttemptRow }
  | { ok: false; reasonCode: 'contended' }

/**
 * Claims a provisioning attempt. The partial unique index on
 * (task_id) WHERE status IN ('claimed','created','verified') is the concurrency
 * primitive: two concurrent Start Triage calls produce at most one attempt, so
 * at most one worktree and exactly one provider invocation.
 *
 * Publishes the intended path to the guard registry in the same synchronous
 * block as the commit — before any Git command can run.
 */
export function claimAttempt(
  db: Database.Database,
  args: ClaimAttemptArgs,
  nowMs: number
): ClaimAttemptResult {
  const id = generateAttemptId()
  db.exec('BEGIN IMMEDIATE')
  try {
    if (getLiveAttempt(db, args.taskId)) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'contended' }
    }
    try {
      db.prepare(
        `INSERT INTO audited_worktree_attempts (
           id, task_id, status, intended_branch, intended_path, intended_base_commit,
           intended_common_dir, provenance_id, claimed_at_ms
         ) VALUES (?, ?, 'claimed', ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        args.taskId,
        args.intendedBranch,
        args.intendedPath,
        args.intendedBaseCommit,
        args.intendedCommonDir,
        args.provenanceId,
        nowMs
      )
    } catch {
      // Partial unique index rejected a concurrent duplicate — same closed
      // outcome as losing the read above.
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'contended' }
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  // Same synchronous block as the commit: no await interleaves here.
  publishAuditedWorktreePath(args.intendedPath)

  const attempt = getAttemptById(db, id)
  if (!attempt) {
    throw new Error(`audited worktree attempt ${id} vanished after claim`)
  }
  return { ok: true, attempt }
}

export type AdvanceAttemptResult = { ok: boolean }

/** CAS an attempt from one status to another; keeps the path guarded. */
export function advanceAttemptStatus(
  db: Database.Database,
  attemptId: string,
  fromStatus: WorktreeAttemptStatus,
  toStatus: WorktreeAttemptStatus,
  nowMs: number
): AdvanceAttemptResult {
  const result =
    toStatus === 'created'
      ? db
          .prepare(
            `UPDATE audited_worktree_attempts SET status = ?, created_at_ms = ?
              WHERE id = ? AND status = ?`
          )
          .run(toStatus, nowMs, attemptId, fromStatus)
      : db
          .prepare(
            `UPDATE audited_worktree_attempts SET status = ? WHERE id = ? AND status = ?`
          )
          .run(toStatus, attemptId, fromStatus)
  return { ok: result.changes === 1 }
}

/** Terminal statuses that KEEP the path guarded (evidence remains on disk). */
export function markAttemptFailedAmbiguous(
  db: Database.Database,
  attemptId: string,
  reasonCode: WorktreeReasonCode,
  nowMs: number
): AdvanceAttemptResult {
  const result = db
    .prepare(
      `UPDATE audited_worktree_attempts
          SET status = 'failed_ambiguous', reason_code = ?, finalized_at_ms = ?
        WHERE id = ? AND status IN ('claimed','created','verified')`
    )
    .run(reasonCode, nowMs, attemptId)
  return { ok: result.changes === 1 }
}

/**
 * Terminal statuses that RELEASE the path. Only legal when every evidence
 * channel was proven absent — the caller must have established that first.
 */
export function markAttemptReleased(
  db: Database.Database,
  attemptId: string,
  toStatus: 'failed_no_effect' | 'abandoned',
  reasonCode: WorktreeReasonCode | null,
  nowMs: number
): AdvanceAttemptResult {
  const attempt = getAttemptById(db, attemptId)
  const result = db
    .prepare(
      `UPDATE audited_worktree_attempts
          SET status = ?, reason_code = ?, finalized_at_ms = ?
        WHERE id = ? AND status IN ('claimed','created','verified')`
    )
    .run(toStatus, reasonCode, nowMs, attemptId)
  if (result.changes !== 1) {
    return { ok: false }
  }
  if (attempt) {
    // Release after the CAS succeeds — the only place this is permitted.
    releaseAuditedWorktreePath(attempt.intendedPath)
  }
  return { ok: true }
}

export function markAttemptFinalized(
  db: Database.Database,
  attemptId: string,
  nowMs: number
): AdvanceAttemptResult {
  const result = db
    .prepare(
      `UPDATE audited_worktree_attempts
          SET status = 'finalized', reason_code = NULL, finalized_at_ms = ?
        WHERE id = ? AND status IN ('claimed','created','verified','finalized')`
    )
    .run(nowMs, attemptId)
  return { ok: result.changes === 1 }
}

/**
 * Rebuilds the guard registry from both durable sources. Runs before any Git
 * mutation handler is registered, so a mid-provisioning crash cannot leave a
 * live attempt's worktree mutable after restart.
 */
export function rebuildRegistryFromDatabase(db: Database.Database): string[] {
  // FAIL-CLOSED, and it must be enforced HERE rather than only in the service
  // wrapper: a prior successful rebuild leaves a `ready` snapshot behind, and
  // that snapshot cannot include any audited worktree created since. Retaining
  // it after a query failure would permit mutation of a newer audited worktree.
  //
  // The full replacement set is built locally first; the registry is only
  // touched once BOTH durable-source queries have succeeded.
  let paths: string[]
  try {
    const taskPaths = db
      .prepare(`SELECT worktree_path FROM audited_tasks WHERE worktree_path IS NOT NULL`)
      .all() as { worktree_path: string }[]
    const attempts = listGuardedAttempts(db)
    paths = [
      ...taskPaths.map((row) => row.worktree_path),
      ...attempts.map((attempt) => attempt.intendedPath)
    ].filter((path): path is string => Boolean(path))
  } catch (error) {
    // Drops any cached guarded paths and sets state to 'unavailable', even if
    // the registry was previously 'ready'.
    markAuditedWorktreeRegistryUnavailable()
    throw error
  }

  rebuildAuditedWorktreeRegistry(paths)
  return paths
}
