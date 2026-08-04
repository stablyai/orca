// Phase 6 schema: per-criterion coverage recorded by a Codex plan-audit run.
//
// Split out of audited-task-schema.ts so that file stays within its line budget
// without a max-lines suppression, matching audited-plan-review-schema.ts. This
// module owns ONLY the Phase 6 DDL; audited-task-schema.ts still owns the version
// constant and drives the migration.
//
// COVERAGE IS RUN EVIDENCE, NOT TASK STATE. Rows are immutable: a new audit
// writes rows under a new run_id and never updates an earlier run's. "Current"
// coverage is DERIVED (see audited-plan-coverage-repository.ts) by resolving the
// latest succeeded run still bound to the task's current artifact — which is why
// there is no coverage column on audited_tasks to keep in sync, and why a
// superseded plan's coverage disappears with no invalidation step.
import type Database from '../sqlite/sync-database'

/**
 * Creates audited_plan_coverage.
 *
 * Shared by fresh-DB creation and the v5->v6 migration so both paths produce an
 * identical table, including the CHECK and the primary key.
 */
export function createPlanCoverageTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audited_plan_coverage (
      run_id        TEXT NOT NULL,
      -- Denormalized from the run row purely so the projection read can filter by
      -- task before joining. The run_id remains the authority for which audit
      -- produced the row.
      task_id       TEXT NOT NULL,
      criterion_id  TEXT NOT NULL,
      covered       INTEGER NOT NULL CHECK(covered IN (0, 1)),
      -- Model-authored, sanitized and truncated BEFORE insert. The only free text
      -- this table carries, and the only field of it that reaches the renderer.
      note          TEXT,
      created_at_ms INTEGER NOT NULL,
      -- ONE judgement per criterion per run. A second row could only come from a
      -- duplicate finalize — a retried finalize, a double-fired handler, or a bug
      -- — so this makes it a hard, CAS-detectable failure at the DB layer instead
      -- of a silent second opinion. Mirrors UNIQUE(run_id) on
      -- audited_plan_artifacts.
      PRIMARY KEY (run_id, criterion_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_audited_plan_coverage_task
      ON audited_plan_coverage(task_id);
  `)
}
