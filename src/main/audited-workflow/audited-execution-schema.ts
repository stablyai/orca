// Phase 4 schema: the Claude execution run.
//
// Split out of audited-task-schema.ts alongside audited-plan-review-schema.ts
// so each phase owns its own DDL and that file stays within its line budget
// without a max-lines suppression.
import {
  EXECUTION_MODES,
  EXECUTION_REASON_CODES,
  EXECUTION_RUN_STATUSES
} from '../../shared/audited-execution-types'
import type Database from '../sqlite/sync-database'
/**
 * Phase 4: one row per Claude Code execution. Output CONTENT is never stored
 * here — only byte counters and a truncation flag; the bounded head+tail logs
 * live on disk and are never projected to the renderer.
 *
 * Shared by fresh-DB creation and the v3->v4 migration so both paths produce an
 * identical table, including its CHECK constraints.
 */
export function createExecutionRunsTable(db: Database.Database): void {
  const modeList = EXECUTION_MODES.map((m) => `'${m}'`).join(', ')
  const statusList = EXECUTION_RUN_STATUSES.map((s) => `'${s}'`).join(', ')
  const reasonList = EXECUTION_REASON_CODES.map((r) => `'${r}'`).join(', ')
  db.exec(`
    CREATE TABLE IF NOT EXISTS audited_execution_runs (
      id                TEXT PRIMARY KEY,
      task_id           TEXT NOT NULL,
      mode              TEXT NOT NULL CHECK(mode IN (${modeList})),
      status            TEXT NOT NULL CHECK(status IN (${statusList})),
      -- The state the task held BEFORE this run's start transition. Recorded at
      -- start so cancel restores the exact pre-launch state instead of guessing:
      -- 'planning' for plan mode, 'ready_to_implement' for direct. Never inferred.
      pre_launch_state  TEXT NOT NULL CHECK(pre_launch_state IN ('planning','ready_to_implement')),
      -- The state the run LIVES in. Distinct from pre_launch_state for direct
      -- runs; this is the value written to pre_block_state on failure.
      active_run_state  TEXT NOT NULL CHECK(active_run_state IN ('planning','implementing')),
      reason_code       TEXT CHECK(reason_code IS NULL OR reason_code IN (${reasonList})),
      exit_code         INTEGER,
      stdout_bytes      INTEGER NOT NULL DEFAULT 0,
      stderr_bytes      INTEGER NOT NULL DEFAULT 0,
      output_truncated  INTEGER NOT NULL DEFAULT 0,
      worktree_verified_at_ms INTEGER NOT NULL,
      started_at_ms     INTEGER NOT NULL,
      ended_at_ms       INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_audited_execution_runs_task
      ON audited_execution_runs(task_id);
    -- At most one live run per task: the CAS primitive that makes a duplicate
    -- Start click a no-op rather than a second Claude process.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audited_execution_runs_running
      ON audited_execution_runs(task_id) WHERE status = 'running';
  `)
}
