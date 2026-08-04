// Finalization of a Codex plan-review run (Phase 5).
//
// TWO PERMISSIONS WITH DIFFERENT WRITE SCOPES. This is the correction that makes
// the contract truthful — the older "three checks before any write" framing was
// self-contradictory, because a stale run IS deliberately recorded as terminal.
//
//   A — RUN OWNERSHIP: is this review row still `running` and still mine?
//       Authorizes writing THIS REVIEW ROW's terminal status/verdict/counters.
//
//   B — FRESHNESS: is the run's artifact still the task's current one (by id AND
//       hash), and is the task still awaiting_plan_review?
//       Authorizes writing THE TASK — its state, last_verdict, a transition, and
//       (Phase 6) the run's per-criterion coverage rows.
//
// So: permission A is checked before ANY write; permission B is checked before
// any TASK write. When A holds but B does not, the review row is finalized
// `failed` with artifact_superseded / task_state_changed and the task is left
// byte-identical. Leaving such a run `running` instead would block the next
// audit behind the partial unique index and be reclassified `interrupted` on the
// next restart — strictly less truthful than recording why it was discarded.
//
// `verdict` is stored NULL on both stale paths on purpose: a durable `approved`
// row that no longer refers to the current plan is exactly the artifact a future
// bug could mistake for authorization.
import type Database from '../sqlite/sync-database'
import type { AuditedTaskState } from '../../shared/audited-workflow-types'
import type {
  PlanReviewReasonCode,
  PlanReviewRunStatus,
  PlanReviewVerdict
} from '../../shared/audited-plan-artifact-types'
import type { CoverageRow } from '../../shared/audited-plan-artifact-types'
import { getPlanReviewRun } from './audited-plan-review-run-repository'
import { insertCoverageRows } from './audited-plan-coverage-repository'
import {
  validateAuditedTransition,
  validateBlockTransition
} from './audited-workflow-state-machine'

export type PlanReviewOutputCounters = {
  stdoutBytes: number
  stderrBytes: number
  outputTruncated: boolean
  exitCode: number | null
}

export type FinalizePlanReviewArgs = {
  runId: string
  taskId: string
  status: Exclude<PlanReviewRunStatus, 'running'>
  reasonCode: PlanReviewReasonCode | null
  /** Null unless this run legitimately produced one. */
  verdict: PlanReviewVerdict | null
  summary: string | null
  findingCount: number | null
  /**
   * Where the task should land. Null means "leave the task alone" — used for
   * every outcome that is not a verdict-driven move.
   */
  toState: AuditedTaskState | null
  blockedReasonCode: string | null
  preBlockState: AuditedTaskState | null
  blockedPhase: string | null
  eventType: string
  counters: PlanReviewOutputCounters
  /**
   * Reconciled, sanitized per-criterion coverage (Phase 6). Empty for every
   * outcome that did not produce a verdict.
   *
   * Written under PERMISSION B, not A: coverage describes the plan that was
   * audited, so a run whose artifact is no longer current must not record it for
   * the same reason it must not record a verdict — a matrix that no longer refers
   * to the current plan is exactly what a later bug could mistake for evidence.
   */
  coverage: readonly CoverageRow[]
}

export type FinalizePlanReviewResult =
  | { ok: true; taskWritten: boolean }
  | {
      ok: false
      reasonCode: 'task_not_found' | 'lock_contended'
    }

/**
 * The coverage summary carried by the EXISTING finalization transition.
 *
 * Phase 6 adds no transition row and no event type. This function exists so
 * coverage rides in `detail_json` — previously NULL on every insert path here —
 * keeping exactly ONE transition per finalize. Several suites assert an exact
 * `COUNT(*) FROM audited_transitions` as a "nothing extra was written"
 * invariant; a second event would break them to add a strictly redundant record,
 * since the immutable audited_plan_coverage rows and the run row already ARE the
 * audit history.
 *
 * Counts only — never criterion ids, note text, or the matrix itself. The
 * transition log says that coverage was recorded and how much of it; the table
 * says what it was.
 */
function coverageDetailJson(coverage: readonly CoverageRow[]): string | null {
  if (coverage.length === 0) {
    return null
  }
  return JSON.stringify({
    covered: coverage.filter((row) => row.covered).length,
    total: coverage.length
  })
}

/**
 * Resolves the state-machine command authorizing a review-driven task move, so
 * this path can never write a state the state machine would refuse.
 */
function validateReviewTransition(from: AuditedTaskState, to: AuditedTaskState): boolean {
  if (to === 'blocked') {
    return validateBlockTransition(from).ok
  }
  const command =
    from === 'awaiting_plan_review' && to === 'plan_fixes_requested'
      ? 'planReviewFixesRequested'
      : null
  if (command === null) {
    return false
  }
  const validation = validateAuditedTransition(command, from)
  return validation.ok && validation.rule.to === to
}

/**
 * Finalizes a review run, and moves the task only if permission B holds.
 *
 * Returns `taskWritten` so the caller can tell a normal finalization from a
 * discarded stale one without re-reading.
 */
export function finalizePlanReviewRun(
  db: Database.Database,
  args: FinalizePlanReviewArgs,
  nowMs: number
): FinalizePlanReviewResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const task = db
      .prepare(`SELECT state, current_plan_artifact_id FROM audited_tasks WHERE id = ?`)
      .get(args.taskId) as { state: string; current_plan_artifact_id: string | null } | undefined
    if (!task) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'task_not_found' }
    }

    // ---- Permission A: run ownership. Checked before ANY write. ----
    const run = getPlanReviewRun(db, args.runId)
    if (!run || run.taskId !== args.taskId || run.status !== 'running') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    // ---- Permission B: freshness. Decides only whether the TASK may move. ----
    const freshness = evaluateFreshness(db, {
      taskState: task.state,
      taskArtifactId: task.current_plan_artifact_id,
      runArtifactId: run.artifactId,
      runArtifactSha256: run.artifactSha256
    })

    const effective =
      freshness === null
        ? { status: args.status, reasonCode: args.reasonCode, verdict: args.verdict }
        : // Stale: record WHY it was discarded, and never a verdict.
          { status: 'failed' as const, reasonCode: freshness, verdict: null }

    const runUpdate = db
      .prepare(
        `UPDATE audited_plan_review_runs
            SET status = ?, reason_code = ?, verdict = ?, summary = ?, finding_count = ?,
                exit_code = ?, stdout_bytes = ?, stderr_bytes = ?, output_truncated = ?,
                ended_at_ms = ?
          WHERE id = ? AND task_id = ? AND status = 'running'`
      )
      .run(
        effective.status,
        effective.reasonCode,
        effective.verdict,
        args.summary,
        args.findingCount,
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

    // A stale run stops here: the review row is terminal, the task is untouched.
    if (freshness !== null) {
      db.exec('COMMIT')
      return { ok: true, taskWritten: false }
    }

    // An `approved` verdict records itself on the task WITHOUT moving it —
    // reaching ready_to_implement additionally requires the human click in
    // approvePlan. Writing last_verdict here is what lets the UI show
    // "Accepted" and what approvePlan's authorization query later joins against,
    // so skipping it would strand a genuine approval.
    if (args.toState === null) {
      if (args.verdict !== null) {
        const verdictUpdate = db
          .prepare(
            `UPDATE audited_tasks SET last_verdict = ?, updated_at_ms = ?
              WHERE id = ? AND state = 'awaiting_plan_review'`
          )
          .run(args.verdict, nowMs, args.taskId)
        if (verdictUpdate.changes !== 1) {
          db.exec('ROLLBACK')
          return { ok: false, reasonCode: 'lock_contended' }
        }
        // Coverage BEFORE the transition, so the transition's counts describe
        // rows already written in this same atomic unit.
        insertCoverageRows(
          db,
          { runId: args.runId, taskId: args.taskId, coverage: args.coverage },
          nowMs
        )
        db.prepare(
          `INSERT INTO audited_transitions
             (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
           VALUES (?, 'awaiting_plan_review', 'awaiting_plan_review', 'codex', ?, NULL, ?, ?)`
        ).run(args.taskId, args.eventType, coverageDetailJson(args.coverage), nowMs)
      }
      db.exec('COMMIT')
      return { ok: true, taskWritten: args.verdict !== null }
    }

    const fromState = task.state as AuditedTaskState
    if (!validateReviewTransition(fromState, args.toState)) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    const taskUpdate = db
      .prepare(
        `UPDATE audited_tasks
            SET state = ?, last_verdict = ?, pre_block_state = ?, blocked_reason_code = ?,
                blocked_phase = ?, updated_at_ms = ?
          WHERE id = ? AND state = ?`
      )
      .run(
        args.toState,
        args.verdict,
        args.preBlockState,
        args.blockedReasonCode,
        args.blockedPhase,
        nowMs,
        args.taskId,
        fromState
      )
    if (taskUpdate.changes !== 1) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    insertCoverageRows(
      db,
      { runId: args.runId, taskId: args.taskId, coverage: args.coverage },
      nowMs
    )

    db.prepare(
      `INSERT INTO audited_transitions
         (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      args.taskId,
      fromState,
      args.toState,
      args.toState === 'blocked' ? 'control' : 'codex',
      args.eventType,
      args.reasonCode,
      coverageDetailJson(args.coverage),
      nowMs
    )

    db.exec('COMMIT')
    return { ok: true, taskWritten: true }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Returns null when the run is still fresh, or the closed code explaining why
 * its verdict may no longer touch the task.
 */
function evaluateFreshness(
  db: Database.Database,
  args: {
    taskState: string
    taskArtifactId: string | null
    runArtifactId: string
    runArtifactSha256: string
  }
): 'artifact_superseded' | 'task_state_changed' | null {
  if (args.taskState !== 'awaiting_plan_review') {
    return 'task_state_changed'
  }
  if (args.taskArtifactId !== args.runArtifactId) {
    return 'artifact_superseded'
  }
  const artifact = db
    .prepare(`SELECT status, content_sha256 FROM audited_plan_artifacts WHERE id = ?`)
    .get(args.runArtifactId) as { status: string; content_sha256: string } | undefined
  if (!artifact || artifact.status !== 'current') {
    return 'artifact_superseded'
  }
  if (artifact.content_sha256 !== args.runArtifactSha256) {
    return 'artifact_superseded'
  }
  return null
}
