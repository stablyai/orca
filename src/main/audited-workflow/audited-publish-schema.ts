// Phase 9 schema: the publish attempt that carries a Phase 8 commit to the remote
// and records the review-request outcome.
//
// Split out of audited-task-schema.ts alongside the other per-phase DDL modules so
// each phase owns its own schema and that file stays within its line budget
// without a max-lines suppression.
//
// DELIBERATELY NOT REUSED: landed_sha / landed_base_sha / landing_reason_code.
// Those belong to the LOCAL-integration lane (fast-forwarding the committed sha
// into the source repo), a different operation from publishing to a remote. Phase
// 9 leaves them, and the landing/landed states, unwritten.
import { PUBLISH_ATTEMPT_STATUSES } from '../../shared/audited-workflow-types'
import type Database from '../sqlite/sync-database'

// Phase 9 columns added to a pre-existing audited_tasks table. ALTER TABLE ADD
// COLUMN cannot carry a CHECK; the narrowing CHECKs live in
// createAuditedWorkflowTables for fresh DBs, and every write site uses typed
// literals — the same rationale as PHASE_3/5/7/8_TASK_COLUMNS.
export const PHASE_9_TASK_COLUMNS: readonly [string, string][] = [
  ['publish_attempt_status', 'TEXT'],
  ['published_sha', 'TEXT'],
  ['review_provider', 'TEXT'],
  ['review_number', 'INTEGER']
]

/**
 * Phase 9 tables.
 *
 * Shared by fresh-DB creation and the v8->v9 migration so both paths produce an
 * identical table, including every CHECK and UNIQUE constraint.
 */
export function createPublishTables(db: Database.Database): void {
  const attemptStatusList = PUBLISH_ATTEMPT_STATUSES.map((s) => `'${s}'`).join(', ')

  db.exec(`
    CREATE TABLE IF NOT EXISTS audited_publish_attempts (
      id                     TEXT PRIMARY KEY,
      task_id                TEXT NOT NULL,
      -- THE PHASE 8 BINDING: both the attempt that produced the commit AND the
      -- exact sha. Either alone is insufficient — an id can match while a later
      -- attempt rewrote the sha, so a stale row could otherwise publish content
      -- no one approved.
      commit_attempt_id      TEXT NOT NULL,
      intended_sha           TEXT NOT NULL,
      intended_branch        TEXT NOT NULL,
      intended_remote        TEXT NOT NULL,
      -- The lease: what the remote ref must still be at for the push to be
      -- allowed. NULL means "expected absent" -> the create-only empty-lease
      -- form. Captured BEFORE the push so recovery knows what the world looked
      -- like when we decided.
      expected_remote_sha    TEXT,
      status                 TEXT NOT NULL CHECK(status IN (${attemptStatusList})),
      reason_code            TEXT,
      -- Set BEFORE the push spawns, so a crash mid-push is classifiable rather
      -- than indistinguishable from "never started".
      push_started           INTEGER NOT NULL DEFAULT 0,
      push_completed         INTEGER NOT NULL DEFAULT 0,
      -- Written only after ls-remote CONFIRMS the remote ref equals intended_sha.
      -- A non-zero push exit is not proof of failure, and a zero exit is not
      -- proof of success, so this is never set from the exit code alone.
      pushed_sha             TEXT,
      -- Review-request evidence. NEVER affects the status column: the push is
      -- durable by the time any of these can be written, so they are advisories.
      review_provider        TEXT,
      review_number          INTEGER,
      review_url             TEXT,
      review_created         INTEGER NOT NULL DEFAULT 0,
      publish_advisory       TEXT,
      authorized_at_ms       INTEGER NOT NULL,
      finalized_at_ms        INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_audited_publish_attempts_task
      ON audited_publish_attempts(task_id);
    -- At most one live attempt per task: the partial-unique-index CAS idiom the
    -- lane has used since Phase 2. This is ALSO what makes "a retry push is
    -- possible only after recovery proves failed_no_effect" a structural
    -- guarantee: while an outcome is unknown the attempt stays authorized, so
    -- admission cannot insert a second one.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audited_publish_attempts_live
      ON audited_publish_attempts(task_id) WHERE status = 'authorized';
  `)
}
