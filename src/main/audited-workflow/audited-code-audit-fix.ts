// Request Fix: the human decision in the code-audit lane (Phase 7).
//
// Moves code_fixes_requested -> awaiting_code_audit and increments fix_round,
// exactly as requestPlanRevision handles plan_round. THE ROUND CAP BINDS HERE AND
// NOWHERE ELSE: fixRound counts COMPLETED fix rounds, and the limit is checked
// when STARTING a fix. Auditing and approving deliberately never consult it, so a
// round-3 candidate remains fully auditable and approvable — checking the cap at
// audit time would strand the final implementation with no way to accept it.
import type Database from '../sqlite/sync-database'
import { MAX_FIX_ROUNDS, type CodeAuditReasonCode } from '../../shared/audited-code-audit-types'
import { hasLiveExecutionRun } from './audited-execution-run-repository'
import { hasLiveCodeAuditRun } from './audited-candidate-repository'
import { validateAuditedTransition } from './audited-workflow-state-machine'

export type RequestCodeFixResult = { ok: true } | { ok: false; reasonCode: CodeAuditReasonCode }

/**
 * Records the human transition into the fix round.
 *
 * Writes only the transition; the caller then starts an ordinary fix-mode
 * execution. A crash in between leaves the task resting in awaiting_code_audit
 * with no run, which the existing Start affordance resumes — the same shape as
 * requestPlanRevision.
 *
 * Note the target state is awaiting_code_audit, which is ALSO where a fix run
 * lives. That is why both live-run guards are checked here: starting a second fix
 * or racing an in-flight audit must be refused before the counter moves.
 */
export function requestCodeFix(
  db: Database.Database,
  taskId: string,
  nowMs: number
): RequestCodeFixResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const task = db
      .prepare(`SELECT state, fix_round FROM audited_tasks WHERE id = ?`)
      .get(taskId) as { state: string; fix_round: number } | undefined
    if (!task) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }
    if (task.state !== 'code_fixes_requested') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }
    if (task.fix_round >= MAX_FIX_ROUNDS) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'round_limit_reached' }
    }
    if (hasLiveExecutionRun(db, taskId)) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'execution_in_progress' }
    }
    if (hasLiveCodeAuditRun(db, taskId)) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'code_audit_in_progress' }
    }

    const validation = validateAuditedTransition('fix', 'code_fixes_requested')
    if (!validation.ok || validation.rule.to !== 'awaiting_code_audit') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }

    // The counter moves with the state, guarded by its own CAS so two clicks
    // cannot both increment it.
    const updated = db
      .prepare(
        `UPDATE audited_tasks
            SET fix_round = fix_round + 1, updated_at_ms = ?
          WHERE id = ? AND state = 'code_fixes_requested' AND fix_round = ?`
      )
      .run(nowMs, taskId, task.fix_round)
    if (updated.changes !== 1) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    db.prepare(
      `INSERT INTO audited_transitions
         (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, 'code_fixes_requested', 'code_fixes_requested', 'human',
               'code_fix_requested', NULL, NULL, ?)`
    ).run(taskId, nowMs)

    db.exec('COMMIT')
    return { ok: true }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
