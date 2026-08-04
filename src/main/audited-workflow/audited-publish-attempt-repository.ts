// Persistence for publish attempts (Phase 9): CAS admission and the per-phase
// evidence writes that make each crash window classifiable.
//
// The invariant: an `authorized` attempt exists ONLY while a publish is in
// flight OR its outcome is still unknown, bound to the Phase 8 commit attempt
// that produced the exact committed_sha. Because admission requires no live
// attempt, an unknown outcome structurally blocks a second push until an
// evidence read classifies it.
//
// EVERY WRITE HERE IS PURE SQLITE. Git and network work happen strictly between
// these calls, never inside their transactions.
import type Database from '../sqlite/sync-database'
import type { PublishAdvisoryCode, PublishReasonCode } from '../../shared/audited-publish-types'
import type { PublishAttemptStatus } from '../../shared/audited-workflow-types'
import type { HostedReviewProvider } from '../../shared/hosted-review'
import { hasLiveCodeAuditRun } from './audited-candidate-repository'
import { hasLiveExecutionRun } from './audited-execution-run-repository'

export type PublishAttemptRow = {
  id: string
  taskId: string
  commitAttemptId: string
  intendedSha: string
  intendedBranch: string
  intendedRemote: string
  expectedRemoteSha: string | null
  status: PublishAttemptStatus
  reasonCode: PublishReasonCode | null
  pushStarted: boolean
  pushCompleted: boolean
  pushedSha: string | null
  reviewProvider: HostedReviewProvider | null
  reviewNumber: number | null
  reviewUrl: string | null
  reviewCreated: boolean
  publishAdvisory: PublishAdvisoryCode | null
  authorizedAt: number
  finalizedAt: number | null
}

export function sqliteRowToPublishAttempt(row: Record<string, unknown>): PublishAttemptRow {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    commitAttemptId: row.commit_attempt_id as string,
    intendedSha: row.intended_sha as string,
    intendedBranch: row.intended_branch as string,
    intendedRemote: row.intended_remote as string,
    expectedRemoteSha: (row.expected_remote_sha as string | null) ?? null,
    status: row.status as PublishAttemptStatus,
    reasonCode: (row.reason_code as PublishReasonCode | null) ?? null,
    pushStarted: Boolean(row.push_started),
    pushCompleted: Boolean(row.push_completed),
    pushedSha: (row.pushed_sha as string | null) ?? null,
    reviewProvider: (row.review_provider as HostedReviewProvider | null) ?? null,
    reviewNumber: (row.review_number as number | null) ?? null,
    reviewUrl: (row.review_url as string | null) ?? null,
    reviewCreated: Boolean(row.review_created),
    publishAdvisory: (row.publish_advisory as PublishAdvisoryCode | null) ?? null,
    authorizedAt: row.authorized_at_ms as number,
    finalizedAt: (row.finalized_at_ms as number | null) ?? null
  }
}

export function generatePublishAttemptId(): string {
  const hex = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `patt_${hex}`
}

export function getPublishAttempt(db: Database.Database, id: string): PublishAttemptRow | null {
  const row = db.prepare(`SELECT * FROM audited_publish_attempts WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined
  return row ? sqliteRowToPublishAttempt(row) : null
}

export function getLatestPublishAttempt(
  db: Database.Database,
  taskId: string
): PublishAttemptRow | null {
  const row = db
    .prepare(
      `SELECT * FROM audited_publish_attempts WHERE task_id = ?
        ORDER BY authorized_at_ms DESC, rowid DESC LIMIT 1`
    )
    .get(taskId) as Record<string, unknown> | undefined
  return row ? sqliteRowToPublishAttempt(row) : null
}

export function getAuthorizedPublishAttempts(
  db: Database.Database
): { id: string; taskId: string }[] {
  return (
    db
      .prepare(`SELECT id, task_id FROM audited_publish_attempts WHERE status = 'authorized'`)
      .all() as { id: string; task_id: string }[]
  ).map((row) => ({ id: row.id, taskId: row.task_id }))
}

/**
 * The Phase 8 binding, resolved by ONE query.
 *
 * Both conditions, not either: the task's latest commit attempt must be
 * `completed` AND its created_commit_sha must equal committed_sha. An id match
 * alone is insufficient, because a later attempt can rewrite the sha.
 *
 * The projection calls this too, so what the UI offers and what admission
 * permits cannot diverge.
 */
export function resolvePublishableCommitAttempt(
  db: Database.Database,
  taskId: string,
  committedSha: string | null
): { attemptId: string } | null {
  if (!committedSha) {
    return null
  }
  const row = db
    .prepare(
      `SELECT id, status, created_commit_sha FROM audited_commit_attempts
        WHERE task_id = ? ORDER BY authorized_at_ms DESC, rowid DESC LIMIT 1`
    )
    .get(taskId) as { id: string; status: string; created_commit_sha: string | null } | undefined
  if (!row || row.status !== 'completed' || row.created_commit_sha !== committedSha) {
    return null
  }
  return { attemptId: row.id }
}

export type AuthorizePublishArgs = {
  taskId: string
  commitAttemptId: string
  intendedSha: string
  intendedBranch: string
  intendedRemote: string
  /** The verified worktree identity this attempt depends on; re-checked here. */
  expectedWorktreePath: string
  expectedWorktreeVerifiedAt: number
}

export type AuthorizePublishResult =
  | { ok: true; attemptId: string; worktreePath: string }
  | { ok: false; reasonCode: PublishReasonCode }

/**
 * CAS-PROTECTED ADMISSION.
 *
 * startPublish necessarily verifies the worktree and reads the remote BEFORE it
 * can open a write transaction, and the task can change in that window.
 * Everything is re-verified HERE, inside BEGIN IMMEDIATE, immediately before the
 * insert:
 *
 *   1. no Claude execution and no code audit is live;
 *   2. the task is still `committed` with a committed_sha;
 *   3. the Phase 8 binding still holds (completed attempt, exact sha);
 *   4. the host is still local;
 *   5. the worktree identity still matches.
 *
 * Any failure returns a closed code and inserts NOTHING, so no attempt exists and
 * the caller never runs a network command.
 *
 * The task state is NOT changed: it stays `committed` throughout, so a failed or
 * ambiguous push can never make the local commit look undone.
 */
export function authorizePublishAttempt(
  db: Database.Database,
  args: AuthorizePublishArgs,
  nowMs: number
): AuthorizePublishResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    if (hasLiveExecutionRun(db, args.taskId)) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }
    if (hasLiveCodeAuditRun(db, args.taskId)) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }

    const task = db
      .prepare(
        `SELECT state, committed_sha, branch_name, worktree_path, worktree_verified_at_ms,
                worktree_reason_code, host_id, wsl_distro
           FROM audited_tasks WHERE id = ?`
      )
      .get(args.taskId) as
      | {
          state: string
          committed_sha: string | null
          branch_name: string | null
          worktree_path: string | null
          worktree_verified_at_ms: number | null
          worktree_reason_code: string | null
          host_id: string
          wsl_distro: string | null
        }
      | undefined
    if (!task) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }
    if (task.state !== 'committed') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'task_not_committed' }
    }
    if (!task.committed_sha) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'committed_sha_missing' }
    }
    if (task.committed_sha !== args.intendedSha) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'commit_attempt_sha_mismatch' }
    }
    if (task.wsl_distro !== null || task.host_id !== 'local') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'publish_host_unsupported' }
    }

    // THE PHASE 8 BINDING, re-resolved inside the transaction.
    const binding = resolvePublishableCommitAttempt(db, args.taskId, task.committed_sha)
    if (!binding) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'commit_attempt_not_completed' }
    }
    if (binding.attemptId !== args.commitAttemptId) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'commit_attempt_sha_mismatch' }
    }

    if (
      task.worktree_path !== args.expectedWorktreePath ||
      task.worktree_verified_at_ms !== args.expectedWorktreeVerifiedAt ||
      task.worktree_reason_code !== null
    ) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'worktree_identity_changed' }
    }
    if (task.branch_name !== args.intendedBranch) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'worktree_identity_changed' }
    }

    const attemptId = generatePublishAttemptId()
    try {
      db.prepare(
        `INSERT INTO audited_publish_attempts
           (id, task_id, commit_attempt_id, intended_sha, intended_branch, intended_remote,
            status, authorized_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, 'authorized', ?)`
      ).run(
        attemptId,
        args.taskId,
        args.commitAttemptId,
        args.intendedSha,
        args.intendedBranch,
        args.intendedRemote,
        nowMs
      )
    } catch {
      // The partial unique index rejected a second live attempt. This is ALSO
      // the guard that stops a retry while an outcome is unknown.
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    db.prepare(
      `UPDATE audited_tasks SET publish_attempt_status = 'authorized', updated_at_ms = ?
        WHERE id = ? AND state = 'committed'`
    ).run(nowMs, args.taskId)

    db.prepare(
      `INSERT INTO audited_transitions
         (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, 'committed', 'committed', 'human', 'publish_authorized', NULL, NULL, ?)`
    ).run(args.taskId, nowMs)

    db.exec('COMMIT')
    // The cwd the caller must use: read INSIDE this transaction and proven to
    // match the verified identity. A captured path is never authoritative.
    return { ok: true, attemptId, worktreePath: task.worktree_path! }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

// Per-phase evidence writes and finalization live in their own module so this
// file stays within its line budget; re-exported so call sites import one name.
export * from './audited-publish-attempt-finalize'
