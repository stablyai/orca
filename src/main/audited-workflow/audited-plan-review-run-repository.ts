// Persistence for Codex plan-review runs (Phase 5): admission, lookup, and the
// artifact-currency re-check that gates every spawn.
//
// The invariant this file exists to hold: a `running` review row is created ONLY
// while the task rests in awaiting_plan_review and the artifact it names is
// still the task's current one, by both id and content hash.
import type { AuditMode } from '../../shared/audited-audit-mode-types'
import type Database from '../sqlite/sync-database'
import type {
  PlanReviewRunStatus,
  PlanReviewVerdict
} from '../../shared/audited-plan-artifact-types'
import type { PlanReviewReasonCode } from '../../shared/audited-plan-artifact-types'

export type PlanReviewRunRow = {
  id: string
  taskId: string
  artifactId: string
  artifactSha256: string
  round: number
  status: PlanReviewRunStatus
  verdict: PlanReviewVerdict | null
  reasonCode: PlanReviewReasonCode | null
  findingCount: number | null
  summary: string | null
  exitCode: number | null
  stdoutBytes: number
  stderrBytes: number
  outputTruncated: boolean
  worktreeVerifiedAt: number
  startedAt: number
  endedAt: number | null
}

export function sqliteRowToPlanReviewRun(row: Record<string, unknown>): PlanReviewRunRow {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    artifactId: row.artifact_id as string,
    artifactSha256: row.artifact_sha256 as string,
    round: row.round as number,
    status: row.status as PlanReviewRunStatus,
    verdict: (row.verdict as PlanReviewVerdict | null) ?? null,
    reasonCode: (row.reason_code as PlanReviewReasonCode | null) ?? null,
    findingCount: (row.finding_count as number | null) ?? null,
    summary: (row.summary as string | null) ?? null,
    exitCode: (row.exit_code as number | null) ?? null,
    stdoutBytes: row.stdout_bytes as number,
    stderrBytes: row.stderr_bytes as number,
    outputTruncated: Boolean(row.output_truncated),
    worktreeVerifiedAt: row.worktree_verified_at_ms as number,
    startedAt: row.started_at_ms as number,
    endedAt: (row.ended_at_ms as number | null) ?? null
  }
}

export function generatePlanReviewRunId(): string {
  const hex = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `rev_${hex}`
}

export function getPlanReviewRun(db: Database.Database, runId: string): PlanReviewRunRow | null {
  const row = db.prepare(`SELECT * FROM audited_plan_review_runs WHERE id = ?`).get(runId) as
    | Record<string, unknown>
    | undefined
  return row ? sqliteRowToPlanReviewRun(row) : null
}

export function getRunningPlanReviewRun(
  db: Database.Database,
  taskId: string
): PlanReviewRunRow | null {
  const row = db
    .prepare(`SELECT * FROM audited_plan_review_runs WHERE task_id = ? AND status = 'running'`)
    .get(taskId) as Record<string, unknown> | undefined
  return row ? sqliteRowToPlanReviewRun(row) : null
}

/**
 * Whether a Codex plan review is live for this task.
 *
 * Used by worktree-identity writers to refuse while a run owns the worktree —
 * the admission CAS proves the identity at insert time, and this keeps it true
 * for the life of the run. A plain existence check, so it is safe to call from
 * any transaction context.
 */
export function hasLivePlanReviewRun(db: Database.Database, taskId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 as live FROM audited_plan_review_runs
        WHERE task_id = ? AND status = 'running' LIMIT 1`
    )
    .get(taskId) as { live: number } | undefined
  return row !== undefined
}

export function getLatestPlanReviewRun(
  db: Database.Database,
  taskId: string
): PlanReviewRunRow | null {
  const row = db
    .prepare(
      `SELECT * FROM audited_plan_review_runs WHERE task_id = ?
        ORDER BY started_at_ms DESC, rowid DESC LIMIT 1`
    )
    .get(taskId) as Record<string, unknown> | undefined
  return row ? sqliteRowToPlanReviewRun(row) : null
}

/**
 * Whether a DURABLE `approved` verdict authorizes implementing the task's
 * CURRENT artifact.
 *
 * All four bindings are required: the run must have SUCCEEDED (a run finalized
 * `failed`/`artifact_superseded` must never authorize anything), carry the
 * verdict `approved`, name the task's current artifact, and match that
 * artifact's content hash. This is the single query behind both
 * `planApprovalReady` on the projection and the guard inside approvePlan — they
 * cannot disagree because there is only one definition.
 */
export function hasApprovedVerdictForCurrentArtifact(
  db: Database.Database,
  taskId: string
): boolean {
  const row = db
    .prepare(
      `SELECT r.id
         FROM audited_plan_review_runs r
         JOIN audited_tasks t          ON t.id = r.task_id
         JOIN audited_plan_artifacts a ON a.id = r.artifact_id
        WHERE r.task_id = ?
          AND r.status = 'succeeded'
          AND r.verdict = 'approved'
          AND a.status = 'current'
          AND a.id = t.current_plan_artifact_id
          AND a.content_sha256 = r.artifact_sha256
        LIMIT 1`
    )
    .get(taskId) as { id: string } | undefined
  return row !== undefined
}

export type StartPlanReviewRunArgs = {
  taskId: string
  artifactId: string
  /** The hash the run will be JUDGED against at finalization. */
  artifactSha256: string
  round: number
  worktreeVerifiedAtMs: number
  /** The verified identity this launch depends on; re-checked inside the CAS. */
  expectedWorktreeIdentity: ExpectedWorktreeIdentity
  /** The transport, resolved before admission and recorded on the row. */
  auditMode: AuditMode
}

/**
 * The complete durable worktree identity a launch depends on.
 *
 * Every field the spawn cwd is derived from, plus the two markers that prove the
 * row describes a VERIFIED worktree rather than a half-provisioned one. Compared
 * as a whole inside the admission transaction, so a mutation to any part of it
 * refuses the run.
 */
export type ExpectedWorktreeIdentity = {
  worktreePath: string
  branchName: string
  worktreeProvenance: string
  /** Non-null proves a verification actually ran. */
  worktreeVerifiedAt: number
  /** Must still be null: any reason code means the worktree is not usable. */
  worktreeReasonCode: null
}

export type StartPlanReviewRunResult =
  | { ok: true; runId: string; worktreePath: string }
  | {
      ok: false
      reasonCode:
        | 'illegal_transition'
        | 'lock_contended'
        | 'artifact_superseded'
        | 'worktree_identity_changed'
    }

/**
 * CAS-PROTECTED ADMISSION.
 *
 * startPlanAudit necessarily reads the artifact metadata and its body from disk
 * BEFORE it can open a write transaction, and a concurrent revision can complete
 * in that window — changing current_plan_artifact_id out from under it. Reading
 * first and inserting later without re-checking would spawn Codex against a plan
 * that is already obsolete, burning a model call and producing a verdict that
 * finalization would then have to discard.
 *
 * So everything is re-verified HERE, inside BEGIN IMMEDIATE, immediately before
 * the insert:
 *   1. the task is still awaiting_plan_review;
 *   2. the chosen artifact is still the task's current_plan_artifact_id;
 *   3. that artifact row is still status 'current';
 *   4. its content hash still equals the hash being persisted into the run;
 *   5. the task's WORKTREE IDENTITY still matches, field for field, the identity
 *      that was verified.
 *
 * Check 5 exists because a caller cannot hold the cwd safely on its own. Even
 * with a post-verification reload, the identity can move again while the
 * artifact and criteria are read — so the only place the check is sound is
 * inside this transaction, and the cwd the caller spawns with is the one THIS
 * function read and returns. A captured path is never authoritative.
 *
 * Any failure returns a closed code and inserts NOTHING, so no review row exists
 * and the caller never reaches a spawn.
 *
 * Check 4 is not redundant with check 2: an id can match while the row was
 * rewritten, and comparing the hash the run will be judged against to the hash
 * stored now is what makes admission and finalization refer to the same bytes.
 */
export function startPlanReviewRun(
  db: Database.Database,
  args: StartPlanReviewRunArgs,
  nowMs: number
): StartPlanReviewRunResult {
  db.exec('BEGIN IMMEDIATE')
  try {
    const task = db
      .prepare(
        `SELECT state, current_plan_artifact_id, worktree_path, branch_name,
                worktree_provenance, worktree_verified_at_ms, worktree_reason_code
           FROM audited_tasks WHERE id = ?`
      )
      .get(args.taskId) as
      | {
          state: string
          current_plan_artifact_id: string | null
          worktree_path: string | null
          branch_name: string | null
          worktree_provenance: string | null
          worktree_verified_at_ms: number | null
          worktree_reason_code: string | null
        }
      | undefined
    if (!task) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }
    if (task.state !== 'awaiting_plan_review') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }
    if (task.current_plan_artifact_id !== args.artifactId) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'artifact_superseded' }
    }

    // Check 5 — the whole identity, field for field. Compared before the insert
    // so a mismatch costs nothing but a rollback.
    const expected = args.expectedWorktreeIdentity
    if (
      task.worktree_path !== expected.worktreePath ||
      task.branch_name !== expected.branchName ||
      task.worktree_provenance !== expected.worktreeProvenance ||
      task.worktree_verified_at_ms !== expected.worktreeVerifiedAt ||
      task.worktree_reason_code !== null
    ) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'worktree_identity_changed' }
    }

    const artifact = db
      .prepare(`SELECT status, content_sha256 FROM audited_plan_artifacts WHERE id = ?`)
      .get(args.artifactId) as { status: string; content_sha256: string } | undefined
    if (!artifact || artifact.status !== 'current') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'artifact_superseded' }
    }
    if (artifact.content_sha256 !== args.artifactSha256) {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'artifact_superseded' }
    }

    const runId = generatePlanReviewRunId()
    try {
      db.prepare(
        `INSERT INTO audited_plan_review_runs
           (id, task_id, artifact_id, artifact_sha256, round, status,
            audit_mode, worktree_verified_at_ms, started_at_ms)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`
      ).run(
        runId,
        args.taskId,
        args.artifactId,
        args.artifactSha256,
        args.round,
        // WRITTEN AT ADMISSION, not at finalization: an interrupted run never
        // reaches a finalize and must still be attributable to its transport.
        args.auditMode,
        args.worktreeVerifiedAtMs,
        nowMs
      )
    } catch {
      // The partial unique index rejected a concurrent duplicate start — the
      // last line of defense against two Codex processes for one task.
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    db.exec('COMMIT')
    // The cwd the caller must spawn with: read INSIDE this transaction and
    // proven to match the verified identity. Returning it removes the caller's
    // ability to use a stale captured path even by mistake.
    return { ok: true, runId, worktreePath: task.worktree_path }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
