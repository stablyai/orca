// Persistence for per-criterion coverage (Phase 6): the guarded insert, and the
// derived read that decides what the projection shows.
//
// The invariant this file exists to hold: coverage is only ever ATTRIBUTED to a
// single audit run, and only to one that is still bound to the task's current
// plan artifact by both id and content hash.
import type Database from '../sqlite/sync-database'
import type { CoverageRow } from '../../shared/audited-plan-artifact-types'

/**
 * Inserts one run's reconciled coverage rows.
 *
 * MUST be called inside an already-open transaction that has established run
 * ownership and artifact freshness — it opens none of its own, exactly like the
 * other writes in finalizePlanReviewRun.
 *
 * Deliberately NO `ON CONFLICT` clause. A PRIMARY KEY collision means this run
 * already recorded coverage, which can only come from a duplicate finalize; the
 * throw propagates so the caller rolls back the whole transaction rather than
 * silently merging two opinions. Mirrors how attachPlanArtifact treats
 * UNIQUE(run_id).
 */
export function insertCoverageRows(
  db: Database.Database,
  args: { runId: string; taskId: string; coverage: readonly CoverageRow[] },
  nowMs: number
): void {
  const statement = db.prepare(
    `INSERT INTO audited_plan_coverage
       (run_id, task_id, criterion_id, covered, note, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  for (const row of args.coverage) {
    statement.run(args.runId, args.taskId, row.criterionId, row.covered ? 1 : 0, row.note, nowMs)
  }
}

export type CurrentCoverage = {
  /**
   * Whether a qualifying audit EXISTS. Distinct from "every criterion is
   * uncovered": false means nobody has looked, which the UI must not render as a
   * judgement. See the plan §5.2.
   */
  available: boolean
  byCriterionId: Map<string, { covered: boolean; note: string | null }>
}

const NO_COVERAGE: CurrentCoverage = { available: false, byCriterionId: new Map() }

/**
 * The coverage that describes the task's CURRENT plan.
 *
 * TWO STATEMENTS, NOT ONE JOIN, and the split is load-bearing.
 *
 * Resolving the run first is what makes the result single-valued. A task can
 * legitimately have SEVERAL succeeded runs that all satisfy the four bindings —
 * a retry after a transient failure, or a second audit of an unchanged plan —
 * because those bindings describe the ARTIFACT, not the run. A single query
 * filtered only by them therefore matches rows from every such run, repeating
 * criterion ids and silently producing a merged, order-dependent matrix. An
 * `ORDER BY` narrows nothing without a `LIMIT`.
 *
 * The four bindings are the same ones hasApprovedVerdictForCurrentArtifact uses,
 * so what the UI shows and what authorizes approval cannot drift apart:
 * the run SUCCEEDED, its artifact is still the task's current one, that artifact
 * row is still 'current', and its content hash still matches what the run was
 * judged against.
 *
 * `available` and `byCriterionId` are returned TOGETHER from this one call. Two
 * separate queries could straddle a concurrent finalize and report availability
 * from one run while returning another run's rows, so the run id is resolved in
 * exactly one place and never escapes this function.
 */
export function getCurrentCoverage(db: Database.Database, taskId: string): CurrentCoverage {
  const run = db
    .prepare(
      `SELECT r.id
         FROM audited_plan_review_runs r
         JOIN audited_tasks t          ON t.id = r.task_id
         JOIN audited_plan_artifacts a ON a.id = r.artifact_id
        WHERE r.task_id = ?
          AND r.status = 'succeeded'
          AND a.status = 'current'
          AND a.id = t.current_plan_artifact_id
          AND a.content_sha256 = r.artifact_sha256
        ORDER BY r.started_at_ms DESC, r.rowid DESC
        LIMIT 1`
    )
    .get(taskId) as { id: string } | undefined

  if (!run) {
    return NO_COVERAGE
  }

  // Scoped to the resolved run alone. PRIMARY KEY (run_id, criterion_id) then
  // guarantees at most one row per criterion, so the Map cannot merge entries.
  const rows = db
    .prepare(`SELECT criterion_id, covered, note FROM audited_plan_coverage WHERE run_id = ?`)
    .all(run.id) as { criterion_id: string; covered: number; note: string | null }[]

  return {
    available: true,
    byCriterionId: new Map(
      rows.map((row) => [row.criterion_id, { covered: row.covered === 1, note: row.note }])
    )
  }
}
