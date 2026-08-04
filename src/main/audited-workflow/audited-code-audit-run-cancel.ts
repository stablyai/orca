// Human cancellation of a running Codex code audit (Phase 7).
//
// Like a cancelled plan review and unlike a cancelled EXECUTION, there is no
// state to restore: the task rests in awaiting_code_audit for the whole audit, so
// cancelling leaves it exactly where it was and writes no task row at all. The
// audit row alone becomes terminal.
//
// Cancel runs NO Git command whatsoever. Nothing Codex read is undone, because a
// read-only audit changed nothing to undo — and in particular the candidate is
// untouched, so the next audit judges the same tree.
import type Database from '../sqlite/sync-database'
import { getCodeAuditRun } from './audited-code-audit-run-repository'

export type CancelCodeAuditResult = { ok: true } | { ok: false; reasonCode: 'lock_contended' }

/**
 * Finalizes the run as `cancelled`.
 *
 * MUST be called only after the process tree has already been killed. Ordering is
 * load-bearing: committing while the process still runs would leave a live
 * process with no `running` row — unkillable and invisible to startup recovery.
 */
export function cancelCodeAuditRun(
  db: Database.Database,
  args: { runId: string; taskId: string },
  nowMs: number
): CancelCodeAuditResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const run = getCodeAuditRun(db, args.runId)
    if (!run || run.taskId !== args.taskId || run.status !== 'running') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    const updated = db
      .prepare(
        `UPDATE audited_code_audit_runs
            SET status = 'cancelled', reason_code = 'cancelled_by_user', ended_at_ms = ?
          WHERE id = ? AND task_id = ? AND status = 'running'`
      )
      .run(nowMs, args.runId, args.taskId)
    if (updated.changes !== 1) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    // The human action is real history even though no state changed, so it is
    // recorded with equal from/to — matching cancelPlanReviewRun.
    db.prepare(
      `INSERT INTO audited_transitions
         (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, 'awaiting_code_audit', 'awaiting_code_audit', 'human',
               'code_audit_cancelled', 'cancelled_by_user', NULL, ?)`
    ).run(args.taskId, nowMs)

    db.exec('COMMIT')
    return { ok: true }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
