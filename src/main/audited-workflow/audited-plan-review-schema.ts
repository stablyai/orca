// Phase 5 schema: the durable plan artifact and the Codex plan-review run.
//
// Split out of audited-task-schema.ts so that file stays within its line
// budget without a max-lines suppression. This module owns ONLY the Phase 5
// DDL and its additive task columns; audited-task-schema.ts still owns the
// version constant and drives the migration.
import {
  PLAN_ARTIFACT_STATUSES,
  PLAN_REVIEW_REASON_CODES,
  PLAN_REVIEW_RUN_STATUSES
} from '../../shared/audited-plan-artifact-types'
import { AUDIT_MODES } from '../../shared/audited-audit-mode-types'
import { REVIEW_VERDICTS } from '../../shared/audited-workflow-types'
import type Database from '../sqlite/sync-database'
// Phase 5 columns added to a pre-existing audited_tasks table. ALTER TABLE ADD
// COLUMN cannot carry a CHECK; the narrowing CHECK on last_verdict lives in
// createAuditedWorkflowTables for fresh DBs, and every write site uses typed
// literals from REVIEW_VERDICTS — the same rationale as PHASE_3_TASK_COLUMNS.
export const PHASE_5_TASK_COLUMNS: readonly [string, string][] = [
  ['current_plan_artifact_id', 'TEXT'],
  ['last_verdict', 'TEXT']
]

/**
 * Phase 5: the durable plan artifact and the Codex plan-review run.
 *
 * Plan CONTENT is never stored here — only its sha256, size, and truncation/
 * redaction counters. The sanitized body lives on disk under
 * <userData>/audited-workflow/plans/<artifactId>/plan.md and is served only by
 * an explicit getPlanArtifact call.
 *
 * Shared by fresh-DB creation and the v4->v5 migration so both paths produce an
 * identical table, including every CHECK and UNIQUE constraint.
 */
export function createPlanReviewTables(db: Database.Database): void {
  const artifactStatusList = PLAN_ARTIFACT_STATUSES.map((s) => `'${s}'`).join(', ')
  const reviewStatusList = PLAN_REVIEW_RUN_STATUSES.map((s) => `'${s}'`).join(', ')
  const reviewReasonList = PLAN_REVIEW_REASON_CODES.map((r) => `'${r}'`).join(', ')
  // One vocabulary only: generated from the EXISTING REVIEW_VERDICTS.
  const verdictList = REVIEW_VERDICTS.map((v) => `'${v}'`).join(', ')
  const modeList = AUDIT_MODES.map((m) => `'${m}'`).join(', ')

  db.exec(`
    CREATE TABLE IF NOT EXISTS audited_plan_artifacts (
      id               TEXT PRIMARY KEY,
      task_id          TEXT NOT NULL,
      run_id           TEXT NOT NULL,
      round            INTEGER NOT NULL,
      status           TEXT NOT NULL CHECK(status IN (${artifactStatusList})),
      content_sha256   TEXT NOT NULL,
      char_count       INTEGER NOT NULL,
      truncated        INTEGER NOT NULL DEFAULT 0,
      redaction_count  INTEGER NOT NULL DEFAULT 0,
      superseded_by    TEXT,
      created_at_ms    INTEGER NOT NULL,
      -- ARTIFACT OWNERSHIP: each successful Claude plan execution may create at
      -- most ONE immutable artifact. Artifacts are never rewritten or amended,
      -- so a second row for the same run could only come from a duplicate
      -- derivation — a retried finalize, a double-fired completion handler, or a
      -- bug. This turns that into a hard, CAS-detectable failure at the DB layer
      -- instead of a silent second 'current' plan for the same run.
      UNIQUE(run_id)
    );
    CREATE INDEX IF NOT EXISTS idx_audited_plan_artifacts_task
      ON audited_plan_artifacts(task_id);
    -- At most one 'current' artifact per task: the invariant the whole freshness
    -- model rests on. Superseded rows are retained as audit history.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audited_plan_artifacts_current
      ON audited_plan_artifacts(task_id) WHERE status = 'current';

    CREATE TABLE IF NOT EXISTS audited_plan_review_runs (
      id                TEXT PRIMARY KEY,
      task_id           TEXT NOT NULL,
      -- The EXACT artifact this run audited, plus the hash it was judged
      -- against. Both are captured at admission and re-checked at finalization:
      -- together they are what makes a stale verdict detectable.
      artifact_id       TEXT NOT NULL,
      artifact_sha256   TEXT NOT NULL,
      round             INTEGER NOT NULL,
      status            TEXT NOT NULL CHECK(status IN (${reviewStatusList})),
      verdict           TEXT CHECK(verdict IS NULL OR verdict IN (${verdictList})),
      reason_code       TEXT CHECK(reason_code IS NULL OR reason_code IN (${reviewReasonList})),
      -- HOW this audit reached its model. NULL reads as 'codex_cli' (see
      -- toAuditMode): rows predating v11 all came from the spawned-CLI path, and
      -- defaulting the other way would relabel real Codex audits as no-tools.
      audit_mode        TEXT CHECK(audit_mode IS NULL OR audit_mode IN (${modeList})),
      finding_count     INTEGER,
      -- Sanitized and bounded to 4KB BEFORE insert. The only free text that
      -- later reaches the renderer.
      summary           TEXT,
      exit_code         INTEGER,
      stdout_bytes      INTEGER NOT NULL DEFAULT 0,
      stderr_bytes      INTEGER NOT NULL DEFAULT 0,
      output_truncated  INTEGER NOT NULL DEFAULT 0,
      worktree_verified_at_ms INTEGER NOT NULL,
      started_at_ms     INTEGER NOT NULL,
      ended_at_ms       INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_audited_plan_review_runs_task
      ON audited_plan_review_runs(task_id);
    -- At most one live review per task: the CAS primitive that makes a duplicate
    -- "Run Codex Audit" click a no-op rather than a second Codex process.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audited_plan_review_runs_running
      ON audited_plan_review_runs(task_id) WHERE status = 'running';
  `)
}
