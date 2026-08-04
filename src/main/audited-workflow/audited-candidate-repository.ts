// Persistence for candidate tree identities (Phase 7), including the guarded
// transaction that attaches a freshly derived candidate to its task.
//
// The invariant this file exists to hold: a task's current_candidate_id and its
// single 'current' audited_candidates row are written together or not at all, and
// neither is ever written by a caller that has lost ownership of the execution
// run that produced the work — or that would yank the candidate out from under a
// code audit already judging it.
import type Database from '../sqlite/sync-database'
import type { AuditedTaskState } from '../../shared/audited-workflow-types'
import type { CandidateStatus } from '../../shared/audited-code-audit-types'
import { sqliteRowToTask, type AuditedTaskRow } from './audited-task-row-mapping'
import { revokePendingApprovalInTransaction } from './audited-approval-repository'
import { validateAuditedTransition } from './audited-workflow-state-machine'

export type CandidateRow = {
  id: string
  taskId: string
  runId: string
  round: number
  status: CandidateStatus
  treeOid: string
  baseCommit: string
  branchName: string
  supersededBy: string | null
  createdAt: number
}

export function sqliteRowToCandidate(row: Record<string, unknown>): CandidateRow {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    runId: row.run_id as string,
    round: row.round as number,
    status: row.status as CandidateStatus,
    treeOid: row.tree_oid as string,
    baseCommit: row.base_commit as string,
    branchName: row.branch_name as string,
    supersededBy: (row.superseded_by as string | null) ?? null,
    createdAt: row.created_at_ms as number
  }
}

export function generateCandidateId(): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `cand_${hex}`
}

export function getCandidate(db: Database.Database, candidateId: string): CandidateRow | null {
  const row = db.prepare(`SELECT * FROM audited_candidates WHERE id = ?`).get(candidateId) as
    | Record<string, unknown>
    | undefined
  return row ? sqliteRowToCandidate(row) : null
}

export function getCurrentCandidate(db: Database.Database, taskId: string): CandidateRow | null {
  const row = db
    .prepare(`SELECT * FROM audited_candidates WHERE task_id = ? AND status = 'current'`)
    .get(taskId) as Record<string, unknown> | undefined
  return row ? sqliteRowToCandidate(row) : null
}

/**
 * Whether a Codex code audit is live for this task.
 *
 * Mirrors hasLivePlanReviewRun: a plain existence check, safe to call from inside
 * a transaction. Used by attachCandidate to refuse superseding a candidate that
 * an in-flight audit is currently judging.
 */
export function hasLiveCodeAuditRun(db: Database.Database, taskId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 as live FROM audited_code_audit_runs
        WHERE task_id = ? AND status = 'running' LIMIT 1`
    )
    .get(taskId) as { live: number } | undefined
  return row !== undefined
}

export type AttachCandidateArgs = {
  candidateId: string
  taskId: string
  runId: string
  round: number
  treeOid: string
  baseCommit: string
  branchName: string
  /** The state this run lives in: 'implementing' for a direct run, 'awaiting_code_audit' for a fix. */
  activeRunState: AuditedTaskState
  /** Execution-run counters, finalized in the same transaction. */
  counters: {
    stdoutBytes: number
    stderrBytes: number
    outputTruncated: boolean
    exitCode: number | null
  }
}

export type AttachCandidateResult =
  | { ok: true; task: AuditedTaskRow }
  | {
      ok: false
      reasonCode:
        | 'task_not_found'
        | 'lock_contended'
        | 'illegal_transition'
        | 'duplicate_candidate'
        | 'code_audit_in_progress'
    }

/**
 * Attaches a derived candidate and completes the execution run, in ONE
 * transaction.
 *
 * THE OWNERSHIP CONTRACT (mirroring attachPlanArtifact). The tree was computed
 * OUTSIDE any transaction, so between write-tree and this call a cancel, a
 * startup recovery, or an invariant-violation block can legitimately have taken
 * the task. Four checks must hold BEFORE any write:
 *
 *   1. the exact execution run is still `running`;
 *   2. the task is still in this run's active state — re-read inside the
 *      transaction, never a caller's pre-spawn copy;
 *   3. the intended transition is still legal per the state machine;
 *   4. NO code audit is live. This one is Phase 7-specific: a fix run lives in
 *      awaiting_code_audit, the same state an audit runs in, so a completing fix
 *      could otherwise supersede the very candidate an in-flight audit is
 *      judging — leaving that audit's verdict bound to a tree that is no longer
 *      current, which its own freshness check would then have to discard.
 *
 * If any fails, EVERYTHING rolls back. The derived objects live only in the
 * per-run temp object directory and are deleted by derivation's own `finally`,
 * so a rejected attach leaves nothing behind anywhere.
 */
export function attachCandidate(
  db: Database.Database,
  args: AttachCandidateArgs,
  nowMs: number
): AttachCandidateResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const task = db.prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(args.taskId) as
      | Record<string, unknown>
      | undefined
    if (!task) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'task_not_found' }
    }

    // Check 1 — run ownership.
    const run = db
      .prepare(
        `SELECT status FROM audited_execution_runs WHERE id = ? AND task_id = ? AND status = 'running'`
      )
      .get(args.runId, args.taskId) as { status: string } | undefined
    if (!run) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    // Check 2 — the task is still where this run lives.
    const fromState = task.state as AuditedTaskState
    if (fromState !== args.activeRunState) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    // Check 3 — the transition this call intends is still legal. A direct run
    // completes via implementComplete; a fix run via `fix`, which re-enters
    // awaiting_code_audit from code_fixes_requested.
    const command = fromState === 'implementing' ? 'implementComplete' : 'fix'
    const validation = validateAuditedTransition(command, fromState)
    if (fromState === 'implementing') {
      if (!validation.ok || validation.rule.to !== 'awaiting_code_audit') {
        db.exec('ROLLBACK')
        return { ok: false, reasonCode: 'illegal_transition' }
      }
    } else if (fromState !== 'awaiting_code_audit') {
      // A fix run's active state IS awaiting_code_audit; it does not move the
      // task, so there is no transition to validate beyond the state itself.
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }

    // Check 4 — no audit may be judging the candidate this call would supersede.
    if (hasLiveCodeAuditRun(db, args.taskId)) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'code_audit_in_progress' }
    }

    // Supersede the previous current candidate BEFORE inserting the new one, so
    // the one-current-per-task partial unique index is never transiently
    // violated. An approved tree OID describes the superseded candidate, so it is
    // cleared in the same statement group below.
    db.prepare(
      `UPDATE audited_candidates
          SET status = 'superseded', superseded_by = ?
        WHERE task_id = ? AND status = 'current'`
    ).run(args.candidateId, args.taskId)

    try {
      db.prepare(
        `INSERT INTO audited_candidates
           (id, task_id, run_id, round, status, tree_oid, base_commit, branch_name,
            superseded_by, created_at_ms)
         VALUES (?, ?, ?, ?, 'current', ?, ?, ?, NULL, ?)`
      ).run(
        args.candidateId,
        args.taskId,
        args.runId,
        args.round,
        args.treeOid,
        args.baseCommit,
        args.branchName,
        nowMs
      )
    } catch {
      // UNIQUE(run_id): this run already produced a candidate. A second one could
      // only come from a duplicate derivation, so refuse rather than silently
      // create a second 'current' tree for one execution.
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'duplicate_candidate' }
    }

    // Phase 8: a new candidate also invalidates any pending HUMAN approval, which
    // is bound to the tree that was just superseded. Revoked in THIS transaction
    // so an approval can never outlive the content it authorized. The superseded
    // candidate's store accounting is cleared here too, so store_bytes means
    // exactly one thing everywhere — "this row currently owns a durable store".
    revokePendingApprovalInTransaction(db, args.taskId, nowMs)
    db.prepare(
      `UPDATE audited_candidates SET store_bytes = NULL, store_expires_at_ms = NULL
        WHERE task_id = ? AND status = 'superseded' AND store_bytes IS NOT NULL`
    ).run(args.taskId)

    // A new candidate invalidates any prior audit outcome: the approved tree OID
    // and the recorded verdict both describe work that has just been superseded.
    const taskUpdate = db
      .prepare(
        `UPDATE audited_tasks
            SET state = 'awaiting_code_audit', current_candidate_id = ?,
                audit_approved_tree_oid = NULL, code_audit_verdict = NULL,
                current_approval_id = NULL,
                pre_block_state = NULL, blocked_reason_code = NULL, blocked_phase = NULL,
                updated_at_ms = ?
          WHERE id = ? AND state = ?`
      )
      .run(args.candidateId, nowMs, args.taskId, fromState)
    if (taskUpdate.changes !== 1) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    const runUpdate = db
      .prepare(
        `UPDATE audited_execution_runs
            SET status = 'succeeded', reason_code = NULL, exit_code = ?, stdout_bytes = ?,
                stderr_bytes = ?, output_truncated = ?, ended_at_ms = ?
          WHERE id = ? AND task_id = ? AND status = 'running'`
      )
      .run(
        args.counters.exitCode,
        args.counters.stdoutBytes,
        args.counters.stderrBytes,
        args.counters.outputTruncated ? 1 : 0,
        nowMs,
        args.runId,
        args.taskId
      )
    if (runUpdate.changes !== 1) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    db.prepare(
      `INSERT INTO audited_transitions
         (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, ?, 'awaiting_code_audit', 'claude', ?, NULL, NULL, ?)`
    ).run(
      args.taskId,
      fromState,
      fromState === 'implementing' ? 'implement_complete' : 'fix_complete',
      nowMs
    )

    db.exec('COMMIT')
    const updated = db.prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(args.taskId) as
      | Record<string, unknown>
      | undefined
    if (!updated) {
      throw new Error(`audited task ${args.taskId} vanished after attaching a candidate`)
    }
    return { ok: true, task: sqliteRowToTask(updated) }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
