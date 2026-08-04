// The two human decisions in the plan lane (Phase 5): Approve for
// Implementation, and Request Plan Revision.
//
// THE ready_to_implement INVARIANT. approvePlan is the ONLY write path from the
// plan lane into ready_to_implement. It requires BOTH a durable `approved`
// verdict bound to the task's current artifact AND this explicit human click —
// neither alone advances anything. (The triage `triageAutoDirect` path into
// ready_to_implement is a different lane and is untouched by Phase 5.)
import type Database from '../sqlite/sync-database'
import {
  MAX_PLAN_ROUNDS,
  type PlanApprovalReasonCode,
  type PlanRevisionReasonCode
} from '../../shared/audited-plan-artifact-types'
import { hasApprovedVerdictForCurrentArtifact } from './audited-plan-review-run-repository'
import { validateAuditedTransition } from './audited-workflow-state-machine'

export type ApprovePlanResult = { ok: true } | { ok: false; reasonCode: PlanApprovalReasonCode }
export type RequestPlanRevisionResult =
  | { ok: true }
  | { ok: false; reasonCode: PlanRevisionReasonCode }

/**
 * Moves awaiting_plan_review -> ready_to_implement.
 *
 * Every guard is re-evaluated INSIDE the transaction, never from a projection
 * the renderer read earlier: `planApprovalReady` decides what to draw, this
 * decides what is legal, and only the latter is authoritative.
 */
export function approvePlan(
  db: Database.Database,
  taskId: string,
  nowMs: number
): ApprovePlanResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const task = db
      .prepare(`SELECT state, current_plan_artifact_id FROM audited_tasks WHERE id = ?`)
      .get(taskId) as { state: string; current_plan_artifact_id: string | null } | undefined
    if (!task) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }
    if (task.state !== 'awaiting_plan_review') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }
    if (!task.current_plan_artifact_id) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'artifact_unavailable' }
    }

    const artifact = db
      .prepare(`SELECT status FROM audited_plan_artifacts WHERE id = ?`)
      .get(task.current_plan_artifact_id) as { status: string } | undefined
    if (!artifact) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'artifact_unavailable' }
    }
    if (artifact.status !== 'current') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'artifact_superseded' }
    }

    // The durable authorization. A run finalized `failed`/`artifact_superseded`
    // can never satisfy this — it is neither `succeeded` nor carries a verdict.
    if (!hasApprovedVerdictForCurrentArtifact(db, taskId)) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'no_approved_verdict' }
    }

    const validation = validateAuditedTransition('planReviewApprove', 'awaiting_plan_review')
    if (!validation.ok || validation.rule.to !== 'ready_to_implement') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }

    const updated = db
      .prepare(
        `UPDATE audited_tasks SET state = 'ready_to_implement', updated_at_ms = ?
          WHERE id = ? AND state = 'awaiting_plan_review'`
      )
      .run(nowMs, taskId)
    if (updated.changes !== 1) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    // actor 'human': Codex authorized, the human acted, and the row names who.
    db.prepare(
      `INSERT INTO audited_transitions
         (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, 'awaiting_plan_review', 'ready_to_implement', 'human',
               'plan_review_approved', NULL, NULL, ?)`
    ).run(taskId, nowMs)

    db.exec('COMMIT')
    return { ok: true }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Moves plan_fixes_requested -> planning and increments plan_round.
 *
 * THE ROUND CAP BINDS HERE AND NOWHERE ELSE. planRound counts COMPLETED revision
 * rounds (0 = the original plan), and the limit is checked when STARTING a
 * revision. Auditing and approving deliberately never consult it, so a round-3
 * plan remains fully auditable and approvable — checking the cap at audit time
 * would strand the final plan with no way to accept it.
 *
 * Writes only the transition; the caller then starts an ordinary plan-mode
 * execution. A crash in between leaves the task resting in `planning` with no
 * run, which the existing Start affordance resumes.
 */
export function requestPlanRevision(
  db: Database.Database,
  taskId: string,
  nowMs: number
): RequestPlanRevisionResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const task = db
      .prepare(`SELECT state, plan_round FROM audited_tasks WHERE id = ?`)
      .get(taskId) as { state: string; plan_round: number } | undefined
    if (!task) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }
    if (task.state !== 'plan_fixes_requested') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }
    if (task.plan_round >= MAX_PLAN_ROUNDS) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'round_limit_reached' }
    }

    const validation = validateAuditedTransition('revisePlan', 'plan_fixes_requested')
    if (!validation.ok || validation.rule.to !== 'planning') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }

    const updated = db
      .prepare(
        `UPDATE audited_tasks
            SET state = 'planning', plan_round = plan_round + 1, updated_at_ms = ?
          WHERE id = ? AND state = 'plan_fixes_requested' AND plan_round = ?`
      )
      .run(nowMs, taskId, task.plan_round)
    if (updated.changes !== 1) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    db.prepare(
      `INSERT INTO audited_transitions
         (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, 'plan_fixes_requested', 'planning', 'human',
               'plan_revision_requested', NULL, NULL, ?)`
    ).run(taskId, nowMs)

    db.exec('COMMIT')
    return { ok: true }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
