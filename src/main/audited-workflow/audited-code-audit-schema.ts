// Phase 7 schema: the candidate tree identity and the Codex code-audit run.
//
// Split out of audited-task-schema.ts alongside audited-plan-review-schema.ts and
// audited-plan-coverage-schema.ts so each phase owns its own DDL and that file
// stays within its line budget without a max-lines suppression.
import { AUDIT_MODES } from '../../shared/audited-audit-mode-types'
import {
  CANDIDATE_STATUSES,
  CODE_AUDIT_REASON_CODES,
  CODE_AUDIT_RUN_STATUSES
} from '../../shared/audited-code-audit-types'
import {
  EXECUTION_MODES,
  EXECUTION_REASON_CODES,
  EXECUTION_RUN_STATUSES
} from '../../shared/audited-execution-types'
import { REVIEW_VERDICTS } from '../../shared/audited-workflow-types'
import type Database from '../sqlite/sync-database'

// Phase 7 columns added to a pre-existing audited_tasks table. ALTER TABLE ADD
// COLUMN cannot carry a CHECK; the narrowing CHECK on code_audit_verdict lives in
// createAuditedWorkflowTables for fresh DBs, and every write site uses typed
// literals from REVIEW_VERDICTS — the same rationale as PHASE_3/5_TASK_COLUMNS.
export const PHASE_7_TASK_COLUMNS: readonly [string, string][] = [
  ['current_candidate_id', 'TEXT'],
  ['code_audit_verdict', 'TEXT']
]

/**
 * Phase 7 tables.
 *
 * The candidate tree OID is authorization identity, so it is stored in full and
 * NEVER projected — only the approved one reaches the renderer, shortened to 12
 * characters by shortenCandidateId.
 *
 * Shared by fresh-DB creation and the v6->v7 migration so both paths produce an
 * identical table, including every CHECK and UNIQUE constraint.
 */
export function createCodeAuditTables(db: Database.Database): void {
  const candidateStatusList = CANDIDATE_STATUSES.map((s) => `'${s}'`).join(', ')
  const runStatusList = CODE_AUDIT_RUN_STATUSES.map((s) => `'${s}'`).join(', ')
  const reasonList = CODE_AUDIT_REASON_CODES.map((r) => `'${r}'`).join(', ')
  // One vocabulary only: generated from the EXISTING REVIEW_VERDICTS.
  const verdictList = REVIEW_VERDICTS.map((v) => `'${v}'`).join(', ')
  const modeList = AUDIT_MODES.map((m) => `'${m}'`).join(', ')

  db.exec(`
    CREATE TABLE IF NOT EXISTS audited_candidates (
      id             TEXT PRIMARY KEY,
      task_id        TEXT NOT NULL,
      -- The execution run whose work this candidate describes.
      run_id         TEXT NOT NULL,
      round          INTEGER NOT NULL,
      status         TEXT NOT NULL CHECK(status IN (${candidateStatusList})),
      -- Full 40-hex, computed by git write-tree under an isolated temp index and
      -- temp object dir. Authorization identity: never projected.
      tree_oid       TEXT NOT NULL,
      -- What it was computed against, so a moved base is detectable.
      base_commit    TEXT NOT NULL,
      branch_name    TEXT NOT NULL,
      superseded_by  TEXT,
      -- Phase 8 §0.2/§0.3. store_bytes is the DURABLE on-disk object footprint of
      -- this candidate's promoted store, NULL when it owns none. Set to NULL
      -- INSIDE the transaction that makes the store ineligible, so nulling the
      -- column IS the accounting release — the global budget is derived as
      -- SUM(store_bytes) WHERE status='current', never a second counter.
      store_bytes         INTEGER,
      store_expires_at_ms INTEGER,
      created_at_ms  INTEGER NOT NULL,
      -- CANDIDATE OWNERSHIP: each execution run may produce at most ONE
      -- candidate. A second row could only come from a duplicate derivation — a
      -- retried finalize or a double-fired handler — so this makes it a hard,
      -- CAS-detectable failure instead of a silent second 'current' tree.
      -- Mirrors UNIQUE(run_id) on audited_plan_artifacts.
      UNIQUE(run_id)
    );
    CREATE INDEX IF NOT EXISTS idx_audited_candidates_task ON audited_candidates(task_id);
    -- At most one 'current' candidate per task: the invariant the whole freshness
    -- model rests on. Superseded rows are retained as audit history.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audited_candidates_current
      ON audited_candidates(task_id) WHERE status = 'current';

    CREATE TABLE IF NOT EXISTS audited_code_audit_runs (
      id                TEXT PRIMARY KEY,
      task_id           TEXT NOT NULL,
      -- The EXACT candidate this run audited, plus the tree it was judged
      -- against. Both are captured at admission and re-checked at finalization:
      -- together they are what makes a stale verdict detectable.
      candidate_id      TEXT NOT NULL,
      candidate_tree_oid TEXT NOT NULL,
      round             INTEGER NOT NULL,
      status            TEXT NOT NULL CHECK(status IN (${runStatusList})),
      verdict           TEXT CHECK(verdict IS NULL OR verdict IN (${verdictList})),
      reason_code       TEXT CHECK(reason_code IS NULL OR reason_code IN (${reasonList})),
      -- HOW this audit reached its model. NULL reads as 'codex_cli' (see
      -- toAuditMode): rows predating v11 all came from the spawned-CLI path, and
      -- defaulting the other way would relabel real Codex audits as no-tools.
      audit_mode        TEXT CHECK(audit_mode IS NULL OR audit_mode IN (${modeList})),
      finding_count     INTEGER,
      -- Sanitized and bounded BEFORE insert. The only free text that reaches the
      -- renderer from this lane.
      summary           TEXT,
      exit_code         INTEGER,
      stdout_bytes      INTEGER NOT NULL DEFAULT 0,
      stderr_bytes      INTEGER NOT NULL DEFAULT 0,
      output_truncated  INTEGER NOT NULL DEFAULT 0,
      worktree_verified_at_ms INTEGER NOT NULL,
      started_at_ms     INTEGER NOT NULL,
      ended_at_ms       INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_audited_code_audit_runs_task
      ON audited_code_audit_runs(task_id);
    -- At most one live audit per task: the CAS primitive that makes a duplicate
    -- "Run Code Audit" click a no-op rather than a second Codex process.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audited_code_audit_runs_running
      ON audited_code_audit_runs(task_id) WHERE status = 'running';
  `)
}

/**
 * The v6->v7 rebuild of audited_execution_runs.
 *
 * THE ONE NON-ADDITIVE STEP IN THIS FEATURE'S HISTORY. A fix run lives in
 * `code_fixes_requested -> awaiting_code_audit`, but the table pins
 * pre_launch_state to ('planning','ready_to_implement') and active_run_state to
 * ('planning','implementing'). SQLite cannot ALTER a CHECK, so the table is
 * rebuilt with widened constraints — SQLite's documented 12-step procedure,
 * minus the steps that do not apply here (no foreign keys, no views, no
 * triggers reference this table).
 *
 * Runs INSIDE the caller's migration transaction, which bumps user_version only
 * on success — so a failure anywhere leaves a v6 database untouched.
 */
export function rebuildExecutionRunsForFixMode(db: Database.Database): void {
  // Generated from the SAME vocabularies createExecutionRunsTable uses, so the
  // rebuild cannot silently narrow a constraint (an early draft hardcoded the
  // status list and would have dropped `blocked`). Only the two state CHECKs are
  // deliberately widened.
  const modeList = EXECUTION_MODES.map((m) => `'${m}'`).join(', ')
  const statusList = EXECUTION_RUN_STATUSES.map((s) => `'${s}'`).join(', ')
  const reasonList = EXECUTION_REASON_CODES.map((r) => `'${r}'`).join(', ')
  db.exec(`
    CREATE TABLE audited_execution_runs_v7 (
      id                TEXT PRIMARY KEY,
      task_id           TEXT NOT NULL,
      mode              TEXT NOT NULL CHECK(mode IN (${modeList})),
      status            TEXT NOT NULL CHECK(status IN (${statusList})),
      pre_launch_state  TEXT NOT NULL CHECK(pre_launch_state IN ('planning','ready_to_implement','code_fixes_requested')),
      active_run_state  TEXT NOT NULL CHECK(active_run_state IN ('planning','implementing','awaiting_code_audit')),
      reason_code       TEXT CHECK(reason_code IS NULL OR reason_code IN (${reasonList})),
      exit_code         INTEGER,
      stdout_bytes      INTEGER NOT NULL DEFAULT 0,
      stderr_bytes      INTEGER NOT NULL DEFAULT 0,
      output_truncated  INTEGER NOT NULL DEFAULT 0,
      worktree_verified_at_ms INTEGER NOT NULL,
      started_at_ms     INTEGER NOT NULL,
      ended_at_ms       INTEGER
    );
    INSERT INTO audited_execution_runs_v7
      (id, task_id, mode, status, pre_launch_state, active_run_state, reason_code,
       exit_code, stdout_bytes, stderr_bytes, output_truncated,
       worktree_verified_at_ms, started_at_ms, ended_at_ms)
    SELECT
       id, task_id, mode, status, pre_launch_state, active_run_state, reason_code,
       exit_code, stdout_bytes, stderr_bytes, output_truncated,
       worktree_verified_at_ms, started_at_ms, ended_at_ms
    FROM audited_execution_runs;
    DROP TABLE audited_execution_runs;
    ALTER TABLE audited_execution_runs_v7 RENAME TO audited_execution_runs;
    CREATE INDEX IF NOT EXISTS idx_audited_execution_runs_task
      ON audited_execution_runs(task_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audited_execution_runs_running
      ON audited_execution_runs(task_id) WHERE status = 'running';
  `)
}
