// CAS writes that block a task for a worktree failure and restore it on
// successful recovery. Split from the provisioning orchestrator so the state
// transitions are reviewable on their own.
//
// blockedReasonCode stays narrow (one of the two generic worktree block codes);
// the detailed WorktreeReasonCode lives in worktree_reason_code.
import type Database from '../sqlite/sync-database'
import type { AuditedTaskState } from '../../shared/audited-workflow-types'
import type { WorktreeReasonCode } from '../../shared/audited-worktree-types'
import { mapWorktreeReasonToBlockReason } from '../../shared/audited-worktree-reason-mapping'

export type WorktreeTaskWriteResult = { ok: boolean }

/**
 * Blocks a task for a worktree failure, recording the prior state so an
 * explicit recovery can restore it. Idempotent: a task already blocked with the
 * same reason is left alone rather than losing its original pre_block_state.
 */
export function blockTaskForWorktreeFailure(
  db: Database.Database,
  taskId: string,
  fromState: AuditedTaskState,
  reasonCode: WorktreeReasonCode,
  nowMs: number
): WorktreeTaskWriteResult {
  // Refusing fromState='blocked' is load-bearing, not just defensive: re-blocking
  // an already-blocked task would overwrite the FIRST writer's reason and set
  // pre_block_state='blocked', destroying the state recovery must restore to.
  // The first terminal classification wins.
  if (fromState === 'blocked') {
    return { ok: false }
  }

  const blockReason = mapWorktreeReasonToBlockReason(reasonCode)
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = db
      .prepare(
        `UPDATE audited_tasks
            SET state = 'blocked',
                pre_block_state = ?,
                blocked_reason_code = ?,
                blocked_phase = 'worktree',
                worktree_reason_code = ?,
                -- Cleared so worktreeReady cannot stay true on a stale
                -- verification timestamp after a failure is recorded.
                worktree_verified_at_ms = NULL,
                updated_at_ms = ?
          WHERE id = ? AND state = ?`
      )
      .run(fromState, blockReason, reasonCode, nowMs, taskId, fromState)
    if (result.changes !== 1) {
      db.exec('ROLLBACK')
      return { ok: false }
    }
    db.prepare(
      `INSERT INTO audited_transitions (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, ?, 'blocked', 'control', 'worktree_blocked', ?, NULL, ?)`
    ).run(taskId, fromState, reasonCode, nowMs)
    db.exec('COMMIT')
    return { ok: true }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Restores a task blocked by a worktree failure back to its recorded
 * pre_block_state and clears every block field. Preserves triage decision, run
 * status, rounds, and history verbatim — recovery never re-runs triage and never
 * invokes a provider.
 */
export function restoreTaskAfterWorktreeRecovery(
  db: Database.Database,
  taskId: string,
  expectedPreBlockState: AuditedTaskState,
  nowMs: number
): WorktreeTaskWriteResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = db
      .prepare(
        `UPDATE audited_tasks
            SET state = ?,
                pre_block_state = NULL,
                blocked_reason_code = NULL,
                blocked_phase = NULL,
                worktree_reason_code = NULL,
                updated_at_ms = ?
          WHERE id = ? AND state = 'blocked' AND pre_block_state = ?`
      )
      .run(expectedPreBlockState, nowMs, taskId, expectedPreBlockState)
    if (result.changes !== 1) {
      db.exec('ROLLBACK')
      return { ok: false }
    }
    db.prepare(
      `INSERT INTO audited_transitions (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, 'blocked', ?, 'human', 'worktree_recovered', NULL, NULL, ?)`
    ).run(taskId, expectedPreBlockState, nowMs)
    db.exec('COMMIT')
    return { ok: true }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function recordWorktreeVerified(
  db: Database.Database,
  taskId: string,
  nowMs: number
): void {
  db.prepare(
    `UPDATE audited_tasks SET worktree_verified_at_ms = ?, worktree_reason_code = NULL WHERE id = ?`
  ).run(nowMs, taskId)
}
