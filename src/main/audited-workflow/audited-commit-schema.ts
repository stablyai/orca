// Phase 8 schema: the human approval record, the commit attempt, and the durable
// candidate-store reservation.
//
// Split out of audited-task-schema.ts alongside the other per-phase DDL modules so
// each phase owns its own schema and that file stays within its line budget
// without a max-lines suppression.
import { APPROVAL_TTL_PRESETS, COMMIT_ATTEMPT_STATUSES } from '../../shared/audited-workflow-types'
import type Database from '../sqlite/sync-database'

// Phase 8 columns added to a pre-existing audited_tasks table. ALTER TABLE ADD
// COLUMN cannot carry a CHECK; the narrowing CHECKs live in
// createAuditedWorkflowTables for fresh DBs, and every write site uses typed
// literals — the same rationale as PHASE_3/5/7_TASK_COLUMNS.
export const PHASE_8_TASK_COLUMNS: readonly [string, string][] = [
  ['current_approval_id', 'TEXT'],
  ['commit_attempt_status', 'TEXT']
]

// Phase 8 columns added to a pre-existing audited_candidates table (§0.2/§0.3).
export const PHASE_8_CANDIDATE_COLUMNS: readonly [string, string][] = [
  ['store_bytes', 'INTEGER'],
  ['store_expires_at_ms', 'INTEGER']
]

/**
 * Phase 8 tables.
 *
 * Shared by fresh-DB creation and the v7->v8 migration so both paths produce an
 * identical table, including every CHECK and UNIQUE constraint.
 */
export function createCommitTables(db: Database.Database): void {
  const attemptStatusList = COMMIT_ATTEMPT_STATUSES.map((s) => `'${s}'`).join(', ')
  const ttlPresetList = APPROVAL_TTL_PRESETS.map((p) => `'${p}'`).join(', ')

  db.exec(`
    CREATE TABLE IF NOT EXISTS audited_approvals (
      id                  TEXT PRIMARY KEY,
      task_id             TEXT NOT NULL,
      -- THE BINDING: both the row the audit judged AND the exact bytes. Either
      -- alone is insufficient — an id can match while the row was rewritten.
      candidate_id        TEXT NOT NULL,
      approved_tree_oid   TEXT NOT NULL,
      base_commit         TEXT NOT NULL,
      branch_name         TEXT NOT NULL,
      state               TEXT NOT NULL CHECK(state IN ('pending','expired','consumed','revoked')),
      ttl_preset          TEXT NOT NULL CHECK(ttl_preset IN (${ttlPresetList})),
      granted_at_ms       INTEGER NOT NULL,
      -- Expiry is EVALUATED against now at every read, never trusted from the
      -- state column alone: a timer that failed to fire must not make a stale
      -- approval usable.
      expires_at_ms       INTEGER NOT NULL,
      consumed_at_ms      INTEGER,
      revoked_at_ms       INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_audited_approvals_task ON audited_approvals(task_id);
    -- At most one live approval per task: the CAS primitive that makes a
    -- double-approve a detectable no-op rather than two authorizations.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audited_approvals_pending
      ON audited_approvals(task_id) WHERE state = 'pending';

    CREATE TABLE IF NOT EXISTS audited_commit_attempts (
      id                      TEXT PRIMARY KEY,
      task_id                 TEXT NOT NULL,
      approval_id             TEXT NOT NULL,
      -- intended_* are written BEFORE any Git command runs, so a crash between
      -- commit-tree and SQLite finalization is recoverable by matching Git
      -- evidence against exactly what this row says was intended (Phase 3 idiom).
      intended_tree_oid       TEXT NOT NULL,
      intended_parent         TEXT NOT NULL,
      intended_branch         TEXT NOT NULL,
      intended_message_sha    TEXT NOT NULL,
      status                  TEXT NOT NULL CHECK(status IN (${attemptStatusList})),
      reason_code             TEXT,
      -- Phase A0. Set BEFORE any object is moved into the real store, so a crash
      -- mid-promotion is classifiable. Only APPROVED objects are ever promoted,
      -- and only after the freshness gate passed in a THROWAWAY store — so a
      -- partial promotion is a subset of bytes the human authorized, never
      -- unapproved worktree content.
      promotion_started       INTEGER NOT NULL DEFAULT 0,
      promotion_completed     INTEGER NOT NULL DEFAULT 0,
      -- The OID recomputed in the throwaway store to prove freshness. Recorded as
      -- evidence; a mismatch aborts before promotion_started is ever set.
      verified_tree_oid       TEXT,
      -- Recorded the moment commit-tree returns, BEFORE update-ref. This is what
      -- makes the A->B crash window classifiable rather than ambiguous.
      created_commit_sha      TEXT,
      ref_updated             INTEGER NOT NULL DEFAULT 0,
      -- Phases C/D. Post-ref-update outcomes. These NEVER affect the status: the
      -- commit is durable by the time either can be written, so they are
      -- advisories, not failures.
      index_refreshed         INTEGER NOT NULL DEFAULT 0,
      post_commit_advisory    TEXT,
      authorized_at_ms        INTEGER NOT NULL,
      finalized_at_ms         INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_audited_commit_attempts_task
      ON audited_commit_attempts(task_id);
    -- At most one live attempt per task: the "authorized" partial-unique-index
    -- idiom audited-task-schema.ts has cited by name since Phase 2.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audited_commit_attempts_live
      ON audited_commit_attempts(task_id) WHERE status = 'authorized';

    -- §0.2. Serialized admission for the GLOBAL durable-store budget. A
    -- reservation is taken in a short transaction containing NO subprocess, so
    -- two concurrent derivations cannot both observe the same headroom.
    CREATE TABLE IF NOT EXISTS audited_store_reservations (
      id            TEXT PRIMARY KEY,
      candidate_id  TEXT NOT NULL,
      -- Durable on-disk object bytes, MEASURED from the ephemeral store after Git
      -- finished writing it — never an estimate from a filesystem preflight.
      bytes         INTEGER NOT NULL,
      state         TEXT NOT NULL CHECK(state IN ('held','released','expired')),
      created_at_ms INTEGER NOT NULL,
      -- DIAGNOSTIC + startup-recovery evidence ONLY. Elapsed time NEVER releases a
      -- reservation: a promotion may still be writing. Only the owning finalizer
      -- releases in-process; only startup recovery reclaims across a crash.
      expires_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audited_store_reservations_state
      ON audited_store_reservations(state);
    -- At most one live reservation per candidate.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audited_store_reservations_held
      ON audited_store_reservations(candidate_id) WHERE state = 'held';
  `)
}
