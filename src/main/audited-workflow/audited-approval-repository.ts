// Persistence for human approval records (Phase 8).
//
// THE BINDING. An approval names BOTH the candidate row the code audit judged AND
// the exact tree OID it approved. Either alone is insufficient: an id can match
// while the row was rewritten, and an OID can match a candidate that is no longer
// current. Every gate re-checks both.
//
// EXPIRY IS EVALUATED, NEVER TRUSTED. resolveApprovalState returns 'expired'
// whenever now >= expires_at_ms regardless of the stored value, so a background
// timer that failed to fire can never make a stale approval usable.
import type Database from '../sqlite/sync-database'
import type { ApprovalTtlPreset, AuditedApprovalState } from '../../shared/audited-workflow-types'

export type ApprovalRow = {
  id: string
  taskId: string
  candidateId: string
  approvedTreeOid: string
  baseCommit: string
  branchName: string
  state: 'pending' | 'expired' | 'consumed' | 'revoked'
  ttlPreset: ApprovalTtlPreset
  grantedAt: number
  expiresAt: number
  consumedAt: number | null
  revokedAt: number | null
}

export function sqliteRowToApproval(row: Record<string, unknown>): ApprovalRow {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    candidateId: row.candidate_id as string,
    approvedTreeOid: row.approved_tree_oid as string,
    baseCommit: row.base_commit as string,
    branchName: row.branch_name as string,
    state: row.state as ApprovalRow['state'],
    ttlPreset: row.ttl_preset as ApprovalTtlPreset,
    grantedAt: row.granted_at_ms as number,
    expiresAt: row.expires_at_ms as number,
    consumedAt: (row.consumed_at_ms as number | null) ?? null,
    revokedAt: (row.revoked_at_ms as number | null) ?? null
  }
}

export function generateApprovalId(): string {
  const hex = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `appr_${hex}`
}

export function getApproval(db: Database.Database, approvalId: string): ApprovalRow | null {
  const row = db.prepare(`SELECT * FROM audited_approvals WHERE id = ?`).get(approvalId) as
    | Record<string, unknown>
    | undefined
  return row ? sqliteRowToApproval(row) : null
}

export function getPendingApproval(db: Database.Database, taskId: string): ApprovalRow | null {
  const row = db
    .prepare(`SELECT * FROM audited_approvals WHERE task_id = ? AND state = 'pending'`)
    .get(taskId) as Record<string, unknown> | undefined
  return row ? sqliteRowToApproval(row) : null
}

export function getLatestApproval(db: Database.Database, taskId: string): ApprovalRow | null {
  const row = db
    .prepare(
      `SELECT * FROM audited_approvals WHERE task_id = ?
        ORDER BY granted_at_ms DESC, rowid DESC LIMIT 1`
    )
    .get(taskId) as Record<string, unknown> | undefined
  return row ? sqliteRowToApproval(row) : null
}

/**
 * The projected approval state, with expiry applied against `nowMs`.
 *
 * A stored 'pending' whose deadline has passed reports 'expired' — the stored
 * value is never the final authority on liveness.
 */
export function resolveApprovalState(
  approval: ApprovalRow | null,
  nowMs: number
): AuditedApprovalState {
  if (!approval) {
    return 'none'
  }
  if (approval.state === 'pending' && nowMs >= approval.expiresAt) {
    return 'expired'
  }
  return approval.state
}

/** Whether a live, unexpired approval exists — the input to `commitReady`. */
export function hasValidPendingApproval(
  db: Database.Database,
  taskId: string,
  nowMs: number
): boolean {
  const pending = getPendingApproval(db, taskId)
  return pending !== null && nowMs < pending.expiresAt
}

/**
 * Whether the task's CURRENT candidate is the one the code audit approved, by
 * both id and tree OID.
 *
 * This is the single query behind `commitApprovalReady`, so what the UI offers
 * and what grantApproval permits cannot diverge.
 */
export function isAuditApprovedForCurrentCandidate(db: Database.Database, taskId: string): boolean {
  const row = db
    .prepare(
      `SELECT t.audit_approved_tree_oid AS approved, t.code_audit_verdict AS verdict,
              c.id AS candidate_id, c.tree_oid AS tree_oid, c.status AS status
         FROM audited_tasks t
         LEFT JOIN audited_candidates c ON c.id = t.current_candidate_id
        WHERE t.id = ?`
    )
    .get(taskId) as
    | {
        approved: string | null
        verdict: string | null
        candidate_id: string | null
        tree_oid: string | null
        status: string | null
      }
    | undefined
  if (!row || !row.approved || row.verdict !== 'approved') {
    return false
  }
  return row.status === 'current' && row.tree_oid === row.approved
}

/**
 * Marks a pending approval consumed. Called in the same transaction that
 * authorizes a commit attempt, so one approval can authorize exactly one attempt.
 */
export function consumeApprovalInTransaction(
  db: Database.Database,
  approvalId: string,
  nowMs: number
): boolean {
  const result = db
    .prepare(
      `UPDATE audited_approvals SET state = 'consumed', consumed_at_ms = ?
        WHERE id = ? AND state = 'pending'`
    )
    .run(nowMs, approvalId)
  return result.changes === 1
}

/**
 * Revokes any pending approval for a task, inside the caller's transaction.
 *
 * Used by attachCandidate: a new candidate supersedes the approved tree, so an
 * approval still bound to the old one must not survive.
 */
export function revokePendingApprovalInTransaction(
  db: Database.Database,
  taskId: string,
  nowMs: number
): number {
  const result = db
    .prepare(
      `UPDATE audited_approvals SET state = 'revoked', revoked_at_ms = ?
        WHERE task_id = ? AND state = 'pending'`
    )
    .run(nowMs, taskId)
  return Number(result.changes)
}
