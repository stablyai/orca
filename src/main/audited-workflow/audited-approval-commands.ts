// The two human decisions in the commit lane (Phase 8): Approve for Commit, and
// Revoke Approval.
//
// THE committing INVARIANT. An approval alone commits nothing, and a Codex
// `approved` verdict alone commits nothing. Reaching `committing` requires BOTH a
// durable audit approval bound to the task's current candidate AND an explicit,
// unexpired human approval — mirroring how approvePlan requires both a verdict
// and a click.
//
// APPROVER IDENTITY IS MAIN-DERIVED. The renderer supplies only a taskId and a
// TTL preset name. A renderer-supplied approver string would be unverifiable, so
// recording one would be security theater in a single-user desktop app.
import type Database from '../sqlite/sync-database'
import {
  APPROVAL_TTL_DURATIONS_MS,
  CANDIDATE_STORE_RETENTION_TTL_MS
} from '../../shared/audited-commit-types'
import type { ApprovalReasonCode, ApprovalTtlPreset } from '../../shared/audited-workflow-types'
import {
  generateApprovalId,
  getPendingApproval,
  isAuditApprovedForCurrentCandidate
} from './audited-approval-repository'
import { hasLiveCodeAuditRun } from './audited-candidate-repository'
import { hasLiveExecutionRun } from './audited-execution-run-repository'

export type GrantApprovalResult = { ok: true } | { ok: false; reasonCode: ApprovalReasonCode }
export type RevokeApprovalResult = { ok: true } | { ok: false; reasonCode: ApprovalReasonCode }

/**
 * Grants a human approval bound to the exact audit-approved candidate tree.
 *
 * Every guard is re-evaluated INSIDE the transaction, never from a projection the
 * renderer read earlier: `commitApprovalReady` decides what to draw, this decides
 * what is legal, and only the latter is authoritative.
 */
export function grantApproval(
  db: Database.Database,
  taskId: string,
  ttlPreset: ApprovalTtlPreset,
  nowMs: number
): GrantApprovalResult {
  const durationMs = APPROVAL_TTL_DURATIONS_MS[ttlPreset]
  if (durationMs === undefined) {
    return { ok: false, reasonCode: 'ttl_preset_invalid' }
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    const task = db
      .prepare(
        `SELECT state, current_candidate_id, audit_approved_tree_oid, code_audit_verdict,
                base_commit, branch_name
           FROM audited_tasks WHERE id = ?`
      )
      .get(taskId) as
      | {
          state: string
          current_candidate_id: string | null
          audit_approved_tree_oid: string | null
          code_audit_verdict: string | null
          base_commit: string
          branch_name: string | null
        }
      | undefined
    if (!task) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'not_awaiting_approval' }
    }
    if (task.state !== 'awaiting_human_approval') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'not_awaiting_approval' }
    }
    if (!task.audit_approved_tree_oid || task.code_audit_verdict !== 'approved') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'no_audit_approved_candidate' }
    }
    if (!task.current_candidate_id || !task.branch_name) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'no_audit_approved_candidate' }
    }

    // The binding check: the current candidate must BE the approved one, by both
    // id and tree OID. A superseded or rewritten row can never satisfy this.
    if (!isAuditApprovedForCurrentCandidate(db, taskId)) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'candidate_identity_changed' }
    }

    // The worktree must be quiescent: a live Claude run or code audit means the
    // tree is moving, so an approval taken now could bind to content that is
    // already changing.
    if (hasLiveExecutionRun(db, taskId) || hasLiveCodeAuditRun(db, taskId)) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    const approvalId = generateApprovalId()
    try {
      db.prepare(
        `INSERT INTO audited_approvals
           (id, task_id, candidate_id, approved_tree_oid, base_commit, branch_name,
            state, ttl_preset, granted_at_ms, expires_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
      ).run(
        approvalId,
        taskId,
        task.current_candidate_id,
        task.audit_approved_tree_oid,
        task.base_commit,
        task.branch_name,
        ttlPreset,
        nowMs,
        nowMs + durationMs
      )
    } catch {
      // The partial unique index rejected a concurrent duplicate — a
      // double-approve is a detectable no-op, not a second authorization.
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    db.prepare(
      `UPDATE audited_tasks SET current_approval_id = ?, updated_at_ms = ? WHERE id = ?`
    ).run(approvalId, nowMs, taskId)

    // Extend the candidate store's retention so an approved candidate cannot be
    // reclaimed out from under a commit the human just authorized.
    db.prepare(`UPDATE audited_candidates SET store_expires_at_ms = ? WHERE id = ?`).run(
      nowMs + CANDIDATE_STORE_RETENTION_TTL_MS,
      task.current_candidate_id
    )

    // The transition row records that a human approved; the state does not move
    // until the commit itself is authorized.
    db.prepare(
      `INSERT INTO audited_transitions
         (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, 'awaiting_human_approval', 'awaiting_human_approval', 'human',
               'commit_approval_granted', NULL, NULL, ?)`
    ).run(taskId, nowMs)

    db.exec('COMMIT')
    return { ok: true }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Revokes a pending approval. A CAS on state='pending', so a double-revoke or a
 * revoke racing a commit authorization is a detectable no-op.
 */
export function revokeApproval(
  db: Database.Database,
  taskId: string,
  nowMs: number
): RevokeApprovalResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const pending = getPendingApproval(db, taskId)
    if (!pending) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'no_pending_approval' }
    }
    const revoked = db
      .prepare(
        `UPDATE audited_approvals SET state = 'revoked', revoked_at_ms = ?
          WHERE id = ? AND state = 'pending'`
      )
      .run(nowMs, pending.id)
    if (revoked.changes !== 1) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }
    db.prepare(
      `UPDATE audited_tasks SET current_approval_id = NULL, updated_at_ms = ? WHERE id = ?`
    ).run(nowMs, taskId)
    db.prepare(
      `INSERT INTO audited_transitions
         (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, ?, ?, 'human', 'commit_approval_revoked', NULL, NULL, ?)`
    ).run(taskId, 'awaiting_human_approval', 'awaiting_human_approval', nowMs)
    db.exec('COMMIT')
    return { ok: true }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
