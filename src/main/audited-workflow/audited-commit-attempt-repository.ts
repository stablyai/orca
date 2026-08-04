// Persistence for commit attempts (Phase 8): CAS admission and the per-phase
// evidence writes that make each crash window classifiable.
//
// The invariant: an `authorized` attempt exists ONLY while the task rests in
// `committing`, bound to an approval that was pending-and-unexpired at admission
// and to the exact candidate tree that approval names.
//
// EVERY WRITE HERE IS PURE SQLITE. Git and filesystem work happen strictly
// between these calls, never inside their transactions.
import type Database from '../sqlite/sync-database'
import type { CommitAdvisoryCode, CommitReasonCode } from '../../shared/audited-commit-types'
import type { CommitAttemptStatus } from '../../shared/audited-workflow-types'
import { consumeApprovalInTransaction, getPendingApproval } from './audited-approval-repository'
import { hasLiveCodeAuditRun } from './audited-candidate-repository'
import { hasLiveExecutionRun } from './audited-execution-run-repository'
import { validateAuditedTransition } from './audited-workflow-state-machine'

export type CommitAttemptRow = {
  id: string
  taskId: string
  approvalId: string
  intendedTreeOid: string
  intendedParent: string
  intendedBranch: string
  intendedMessageSha: string
  status: CommitAttemptStatus
  reasonCode: CommitReasonCode | null
  promotionStarted: boolean
  promotionCompleted: boolean
  verifiedTreeOid: string | null
  createdCommitSha: string | null
  refUpdated: boolean
  indexRefreshed: boolean
  postCommitAdvisory: CommitAdvisoryCode | null
  authorizedAt: number
  finalizedAt: number | null
}

export function sqliteRowToCommitAttempt(row: Record<string, unknown>): CommitAttemptRow {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    approvalId: row.approval_id as string,
    intendedTreeOid: row.intended_tree_oid as string,
    intendedParent: row.intended_parent as string,
    intendedBranch: row.intended_branch as string,
    intendedMessageSha: row.intended_message_sha as string,
    status: row.status as CommitAttemptStatus,
    reasonCode: (row.reason_code as CommitReasonCode | null) ?? null,
    promotionStarted: Boolean(row.promotion_started),
    promotionCompleted: Boolean(row.promotion_completed),
    verifiedTreeOid: (row.verified_tree_oid as string | null) ?? null,
    createdCommitSha: (row.created_commit_sha as string | null) ?? null,
    refUpdated: Boolean(row.ref_updated),
    indexRefreshed: Boolean(row.index_refreshed),
    postCommitAdvisory: (row.post_commit_advisory as CommitAdvisoryCode | null) ?? null,
    authorizedAt: row.authorized_at_ms as number,
    finalizedAt: (row.finalized_at_ms as number | null) ?? null
  }
}

export function generateCommitAttemptId(): string {
  const hex = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `catt_${hex}`
}

export function getCommitAttempt(db: Database.Database, id: string): CommitAttemptRow | null {
  const row = db.prepare(`SELECT * FROM audited_commit_attempts WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined
  return row ? sqliteRowToCommitAttempt(row) : null
}

export function getLatestCommitAttempt(
  db: Database.Database,
  taskId: string
): CommitAttemptRow | null {
  const row = db
    .prepare(
      `SELECT * FROM audited_commit_attempts WHERE task_id = ?
        ORDER BY authorized_at_ms DESC, rowid DESC LIMIT 1`
    )
    .get(taskId) as Record<string, unknown> | undefined
  return row ? sqliteRowToCommitAttempt(row) : null
}

export function getAuthorizedCommitAttempts(
  db: Database.Database
): { id: string; taskId: string }[] {
  return (
    db
      .prepare(`SELECT id, task_id FROM audited_commit_attempts WHERE status = 'authorized'`)
      .all() as { id: string; task_id: string }[]
  ).map((row) => ({ id: row.id, taskId: row.task_id }))
}

export type AuthorizeCommitArgs = {
  taskId: string
  approvalId: string
  intendedTreeOid: string
  intendedParent: string
  intendedBranch: string
  intendedMessageSha: string
  /** The verified worktree identity this attempt depends on; re-checked here. */
  expectedWorktreePath: string
  expectedWorktreeVerifiedAt: number
}

export type AuthorizeCommitResult =
  | { ok: true; attemptId: string; worktreePath: string }
  | { ok: false; reasonCode: CommitReasonCode }

/**
 * CAS-PROTECTED ADMISSION.
 *
 * startCommit necessarily verifies the worktree and re-derives the candidate
 * BEFORE it can open a write transaction, and an approval can be revoked or a
 * candidate superseded in that window. Everything is re-verified HERE, inside
 * BEGIN IMMEDIATE, immediately before the insert:
 *
 *   1. no Claude execution and no code audit is live;
 *   2. the task is still awaiting_human_approval;
 *   3. the approval is still pending AND still unexpired (evaluated, not trusted);
 *   4. the approval still binds the task's current candidate by id AND tree OID;
 *   5. the worktree identity still matches;
 *   6. the commitAuthorize transition is still legal.
 *
 * Any failure returns a closed code and inserts NOTHING, so no attempt exists and
 * the caller never runs a Git command.
 */
export function authorizeCommitAttempt(
  db: Database.Database,
  args: AuthorizeCommitArgs,
  nowMs: number
): AuthorizeCommitResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    if (hasLiveExecutionRun(db, args.taskId)) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'execution_in_progress' }
    }
    if (hasLiveCodeAuditRun(db, args.taskId)) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'code_audit_in_progress' }
    }

    const task = db
      .prepare(
        `SELECT state, current_candidate_id, worktree_path, worktree_verified_at_ms,
                worktree_reason_code
           FROM audited_tasks WHERE id = ?`
      )
      .get(args.taskId) as
      | {
          state: string
          current_candidate_id: string | null
          worktree_path: string | null
          worktree_verified_at_ms: number | null
          worktree_reason_code: string | null
        }
      | undefined
    if (!task) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }
    if (task.state !== 'awaiting_human_approval') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }

    const approval = getPendingApproval(db, args.taskId)
    if (!approval || approval.id !== args.approvalId) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'no_approval' }
    }
    // Expiry is EVALUATED here, so a lapsed approval cannot authorize even if a
    // sweep never ran.
    if (nowMs >= approval.expiresAt) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'approval_expired' }
    }
    if (approval.candidateId !== task.current_candidate_id) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'candidate_superseded' }
    }
    if (approval.approvedTreeOid !== args.intendedTreeOid) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'approval_binding_mismatch' }
    }

    const candidate = db
      .prepare(`SELECT status, tree_oid FROM audited_candidates WHERE id = ?`)
      .get(approval.candidateId) as { status: string; tree_oid: string } | undefined
    if (!candidate || candidate.status !== 'current') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'candidate_superseded' }
    }
    if (candidate.tree_oid !== args.intendedTreeOid) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'candidate_drift' }
    }

    if (
      task.worktree_path !== args.expectedWorktreePath ||
      task.worktree_verified_at_ms !== args.expectedWorktreeVerifiedAt ||
      task.worktree_reason_code !== null
    ) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'worktree_identity_changed' }
    }

    const validation = validateAuditedTransition('commitAuthorize', 'awaiting_human_approval')
    if (!validation.ok || validation.rule.to !== 'committing') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }

    if (!consumeApprovalInTransaction(db, approval.id, nowMs)) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'approval_already_consumed' }
    }

    const attemptId = generateCommitAttemptId()
    try {
      db.prepare(
        `INSERT INTO audited_commit_attempts
           (id, task_id, approval_id, intended_tree_oid, intended_parent, intended_branch,
            intended_message_sha, status, authorized_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'authorized', ?)`
      ).run(
        attemptId,
        args.taskId,
        approval.id,
        args.intendedTreeOid,
        args.intendedParent,
        args.intendedBranch,
        args.intendedMessageSha,
        nowMs
      )
    } catch {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    const moved = db
      .prepare(
        `UPDATE audited_tasks
            SET state = 'committing', commit_attempt_status = 'authorized',
                current_approval_id = NULL, updated_at_ms = ?
          WHERE id = ? AND state = 'awaiting_human_approval'`
      )
      .run(nowMs, args.taskId)
    if (moved.changes !== 1) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    db.prepare(
      `INSERT INTO audited_transitions
         (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, 'awaiting_human_approval', 'committing', 'human',
               'commit_authorized', NULL, NULL, ?)`
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
export * from './audited-commit-attempt-finalize'
