// Phase 10 schema: the land attempt that fast-forwards a Phase 8 commit into the
// user's SOURCE repository, locally.
//
// Split out of audited-task-schema.ts alongside the other per-phase DDL modules so
// each phase owns its own schema and that file stays within its line budget
// without a max-lines suppression.
//
// FIRST WRITER, NOT A NEW OWNER: landed_sha / landed_base_sha /
// landing_reason_code have existed on audited_tasks since Phase 1 and were
// explicitly reserved for this lane (see audited-publish-schema.ts's header).
// Phase 10 adds only the two status columns and this table.
import { LAND_ATTEMPT_STATUSES } from '../../shared/audited-landing-types'
import type Database from '../sqlite/sync-database'

// Phase 10 columns added to a pre-existing audited_tasks table. ALTER TABLE ADD
// COLUMN cannot carry a CHECK; the narrowing CHECKs live in
// createAuditedWorkflowTables for fresh DBs, and every write site uses typed
// literals — the same rationale as PHASE_3/5/7/8/9_TASK_COLUMNS.
export const PHASE_10_TASK_COLUMNS: readonly [string, string][] = [
  ['land_attempt_status', 'TEXT'],
  ['landing_advisory', 'TEXT']
]

/**
 * The v9 -> v10 migration step.
 *
 * FULLY ADDITIVE — no CHECK change on any existing table and no rebuild, because
 * Phase 10 introduces no task state: `landing` and `landed` have been in
 * audited_tasks' state CHECK since Phase 1, and this phase is merely their FIRST
 * WRITER. landed_sha / landed_base_sha / landing_reason_code likewise already
 * exist and are left structurally untouched.
 *
 * Creates the table here rather than relying on createAuditedWorkflowTables
 * having run, for the same reason as v4-v9: migrateAuditedWorkflowSchema is also
 * called directly against a legacy DB, and a migration that silently depends on
 * another call would leave that path without the table.
 */
export function migrateToV10(
  db: Database.Database,
  columnExists: (db: Database.Database, table: string, column: string) => boolean
): void {
  for (const [column, type] of PHASE_10_TASK_COLUMNS) {
    if (!columnExists(db, 'audited_tasks', column)) {
      db.exec(`ALTER TABLE audited_tasks ADD COLUMN ${column} ${type}`)
    }
  }
  createLandTables(db)
}

/**
 * Phase 10 tables.
 *
 * Shared by fresh-DB creation and the v9->v10 migration so both paths produce an
 * identical table, including every CHECK and UNIQUE constraint.
 */
export function createLandTables(db: Database.Database): void {
  const attemptStatusList = LAND_ATTEMPT_STATUSES.map((s) => `'${s}'`).join(', ')

  db.exec(`
    CREATE TABLE IF NOT EXISTS audited_land_attempts (
      id                     TEXT PRIMARY KEY,
      task_id                TEXT NOT NULL,
      -- THE PHASE 8 BINDING: both the attempt that produced the commit AND the
      -- exact sha. Either alone is insufficient — an id can match while a later
      -- attempt rewrote the sha.
      commit_attempt_id      TEXT NOT NULL,
      -- THE PHASE 9 PUBLICATION BINDING, captured at admission. Re-compared
      -- inside the CAS: a DIFFERENT completed attempt satisfying the same sha is
      -- still a change of the world we admitted against, so it fails closed.
      publish_attempt_id     TEXT NOT NULL,
      intended_sha           TEXT NOT NULL,
      intended_branch        TEXT NOT NULL,
      -- The CAS expected-old operand: where the source branch must still be.
      intended_base_sha      TEXT NOT NULL,
      source_repo_path       TEXT NOT NULL,
      -- Repository IDENTITY, not merely a path. A path can be reused by a
      -- different repo; the common dir cannot.
      source_repo_common_dir TEXT NOT NULL,
      status                 TEXT NOT NULL CHECK(status IN (${attemptStatusList})),
      reason_code            TEXT,
      -- Written BEFORE each mutation spawns, so a crash mid-command is
      -- classifiable rather than indistinguishable from "never started".
      ref_update_started        INTEGER NOT NULL DEFAULT 0,
      ref_update_completed      INTEGER NOT NULL DEFAULT 0,
      worktree_update_started   INTEGER NOT NULL DEFAULT 0,
      worktree_update_completed INTEGER NOT NULL DEFAULT 0,
      -- Written only after evidence CONFIRMS the source branch tip carries the
      -- intended sha. A non-zero update-ref exit is not proof nothing happened,
      -- so this is never set from an exit code alone.
      landed_sha             TEXT,
      -- Post-durability conditions only. NEVER affects the status column: the ref
      -- has moved by the time any of these can be written.
      landing_advisory       TEXT,
      authorized_at_ms       INTEGER NOT NULL,
      finalized_at_ms        INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_audited_land_attempts_task
      ON audited_land_attempts(task_id);
    -- At most one live attempt per task: the partial-unique-index CAS idiom the
    -- lane has used since Phase 2. This is ALSO what makes "a retry land is
    -- possible only after recovery proves failed_no_effect" a structural
    -- guarantee: while an outcome is unknown the attempt stays authorized, so
    -- admission cannot insert a second one.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audited_land_attempts_live
      ON audited_land_attempts(task_id) WHERE status = 'authorized';
  `)
}
