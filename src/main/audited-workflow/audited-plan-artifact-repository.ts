// Persistence for plan artifacts (Phase 5), including the guarded transaction
// that attaches a freshly written artifact to its task.
//
// The invariant this file exists to hold: a task's current_plan_artifact_id and
// its single 'current' audited_plan_artifacts row are written together or not at
// all, and neither is ever written by a caller that has lost ownership of the
// execution run that produced the artifact.
import type Database from '../sqlite/sync-database'
import type { AuditedTaskState } from '../../shared/audited-workflow-types'
import type { PlanArtifactStatus } from '../../shared/audited-plan-artifact-types'
import { sqliteRowToTask, type AuditedTaskRow } from './audited-task-row-mapping'
import { validateAuditedTransition } from './audited-workflow-state-machine'

export type PlanArtifactRow = {
  id: string
  taskId: string
  runId: string
  round: number
  status: PlanArtifactStatus
  contentSha256: string
  charCount: number
  truncated: boolean
  redactionCount: number
  supersededBy: string | null
  createdAt: number
}

export function sqliteRowToPlanArtifact(row: Record<string, unknown>): PlanArtifactRow {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    runId: row.run_id as string,
    round: row.round as number,
    status: row.status as PlanArtifactStatus,
    contentSha256: row.content_sha256 as string,
    charCount: row.char_count as number,
    truncated: Boolean(row.truncated),
    redactionCount: row.redaction_count as number,
    supersededBy: (row.superseded_by as string | null) ?? null,
    createdAt: row.created_at_ms as number
  }
}

export function generatePlanArtifactId(): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `plan_${hex}`
}

// The shape audited-plan-artifact-gc.ts uses to decide whether a directory name
// could ever have been produced by generatePlanArtifactId. Anything else is left
// strictly alone.
export const PLAN_ARTIFACT_ID_PATTERN = /^plan_[0-9a-f]{32}$/

export function getPlanArtifact(db: Database.Database, artifactId: string): PlanArtifactRow | null {
  const row = db.prepare(`SELECT * FROM audited_plan_artifacts WHERE id = ?`).get(artifactId) as
    | Record<string, unknown>
    | undefined
  return row ? sqliteRowToPlanArtifact(row) : null
}

export function getCurrentPlanArtifact(
  db: Database.Database,
  taskId: string
): PlanArtifactRow | null {
  const row = db
    .prepare(`SELECT * FROM audited_plan_artifacts WHERE task_id = ? AND status = 'current'`)
    .get(taskId) as Record<string, unknown> | undefined
  return row ? sqliteRowToPlanArtifact(row) : null
}

export function listPlanArtifactIds(db: Database.Database): Set<string> {
  const rows = db.prepare(`SELECT id FROM audited_plan_artifacts`).all() as { id: string }[]
  return new Set(rows.map((row) => row.id))
}

export type AttachPlanArtifactArgs = {
  artifactId: string
  taskId: string
  runId: string
  round: number
  contentSha256: string
  charCount: number
  truncated: boolean
  redactionCount: number
  /** Execution-run counters, finalized in the same transaction. */
  counters: {
    stdoutBytes: number
    stderrBytes: number
    outputTruncated: boolean
    exitCode: number | null
  }
}

export type AttachPlanArtifactResult =
  | { ok: true; task: AuditedTaskRow }
  | {
      ok: false
      reasonCode: 'task_not_found' | 'lock_contended' | 'illegal_transition' | 'duplicate_artifact'
    }

/**
 * Attaches a written artifact and completes the plan run, in ONE transaction.
 *
 * THE OWNERSHIP CONTRACT (plan §3.1). The artifact file was written OUTSIDE any
 * transaction, so between its atomic rename and this call a cancel, a startup
 * recovery, or an invariant-violation block can legitimately have taken the
 * task. Three checks must therefore hold BEFORE any write:
 *
 *   1. the exact execution run is still `running` — this call still owns the
 *      outcome;
 *   2. the task is still `planning` — re-read inside the transaction, never a
 *      caller's pre-spawn copy, which is exactly the stale value a concurrent
 *      writer would exploit;
 *   3. `planComplete` is still legal from that state — the state machine stays
 *      the single definition of legality.
 *
 * If any fails, EVERYTHING rolls back: no artifact row, no pointer, no task
 * write, no transition. The already-renamed file becomes an orphan and is
 * reclaimed by audited-plan-artifact-gc.ts. The losing derivation must never be
 * able to overwrite the winner.
 */
export function attachPlanArtifact(
  db: Database.Database,
  args: AttachPlanArtifactArgs,
  nowMs: number
): AttachPlanArtifactResult {
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
    if (fromState !== 'planning') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'lock_contended' }
    }

    // Check 3 — the transition this call intends is still legal.
    const validation = validateAuditedTransition('planComplete', fromState)
    if (!validation.ok || validation.rule.to !== 'awaiting_plan_review') {
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'illegal_transition' }
    }

    // Supersede the previous current artifact BEFORE inserting the new one, so
    // the one-current-per-task partial unique index is never transiently violated.
    db.prepare(
      `UPDATE audited_plan_artifacts
          SET status = 'superseded', superseded_by = ?
        WHERE task_id = ? AND status = 'current'`
    ).run(args.artifactId, args.taskId)

    try {
      db.prepare(
        `INSERT INTO audited_plan_artifacts
           (id, task_id, run_id, round, status, content_sha256, char_count,
            truncated, redaction_count, superseded_by, created_at_ms)
         VALUES (?, ?, ?, ?, 'current', ?, ?, ?, ?, NULL, ?)`
      ).run(
        args.artifactId,
        args.taskId,
        args.runId,
        args.round,
        args.contentSha256,
        args.charCount,
        args.truncated ? 1 : 0,
        args.redactionCount,
        nowMs
      )
    } catch {
      // UNIQUE(run_id): this run already produced an artifact. A second one
      // could only come from a duplicate derivation, so refuse rather than
      // silently create a second 'current' plan for one execution.
      db.exec('ROLLBACK')
      return { ok: false, reasonCode: 'duplicate_artifact' }
    }

    const taskUpdate = db
      .prepare(
        `UPDATE audited_tasks
            SET state = 'awaiting_plan_review', current_plan_artifact_id = ?,
                pre_block_state = NULL, blocked_reason_code = NULL, blocked_phase = NULL,
                updated_at_ms = ?
          WHERE id = ? AND state = ?`
      )
      .run(args.artifactId, nowMs, args.taskId, fromState)
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
       VALUES (?, ?, 'awaiting_plan_review', 'claude', 'plan_complete', NULL, NULL, ?)`
    ).run(args.taskId, fromState, nowMs)

    db.exec('COMMIT')
    const updated = db.prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(args.taskId) as
      | Record<string, unknown>
      | undefined
    if (!updated) {
      throw new Error(`audited task ${args.taskId} vanished after attaching a plan artifact`)
    }
    return { ok: true, task: sqliteRowToTask(updated) }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
