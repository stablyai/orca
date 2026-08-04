// Schema DDL and migration for the audited-workflow SQLite database. Kept
// separate from the repository class so schema evolution reviews as its own
// unit — see plan §6 for the full multi-phase schema; Phase 1 creates only
// audited_tasks and audited_transitions.
import {
  AUDITED_TASK_STATES,
  TASK_SOURCES,
  RISK_LEVELS,
  TASK_ACTORS,
  TRIAGE_DECISIONS,
  TRIAGE_RUN_STATUSES,
  TRIAGE_REASON_CODES
} from '../../shared/audited-workflow-types'
import {
  WORKTREE_ATTEMPT_STATUSES,
  WORKTREE_PROVENANCE_KINDS,
  WORKTREE_REASON_CODES
} from '../../shared/audited-worktree-types'
import { REVIEW_VERDICTS } from '../../shared/audited-workflow-types'
// Per-phase DDL lives in its own module so this file stays within its line
// budget and each phase's schema reviews as its own unit.
import { createExecutionRunsTable } from './audited-execution-schema'
import { PHASE_5_TASK_COLUMNS, createPlanReviewTables } from './audited-plan-review-schema'
import type Database from '../sqlite/sync-database'

// Schema versions: v1 initial (audited_tasks, audited_transitions). v2 (Phase 2)
// adds audited_triage_runs plus triage status columns on audited_tasks. v3
// (Phase 3) adds audited_worktree_attempts plus worktree identity/provenance
// columns. v4 (Phase 4) adds audited_execution_runs — ALSO FULLY ADDITIVE:
// Phase 4 introduces no new task state (its one new transition rule,
// cancelImplementation, is TypeScript in audited-workflow-state-machine.ts and
// the database has no notion of transition legality), so audited_tasks' state
// CHECK is unchanged and no table rebuild is needed. audited_transitions.event_type
// is unconstrained TEXT, so the new execution_* event types need no migration.
// v5 (Phase 5) adds audited_plan_artifacts + audited_plan_review_runs plus two
// audited_tasks columns (current_plan_artifact_id, last_verdict) — ALSO FULLY
// ADDITIVE. Phase 5 introduces no new task state (its only state-machine change
// retargets the EXISTING `revisePlan` rule, which is TypeScript, not schema), so
// audited_tasks' state CHECK is unchanged. Artifact-file write failures reuse the
// EXISTING `spawn_failed` execution reason rather than adding a code, so
// audited_execution_runs' CHECK is untouched and v5 needs no table rebuild.
export const SCHEMA_VERSION = 5

export function createAuditedWorkflowTables(db: Database.Database): void {
  const stateList = AUDITED_TASK_STATES.map((s) => `'${s}'`).join(', ')
  const sourceList = TASK_SOURCES.map((s) => `'${s}'`).join(', ')
  const riskList = RISK_LEVELS.map((r) => `'${r}'`).join(', ')
  const actorList = TASK_ACTORS.map((a) => `'${a}'`).join(', ')
  const triageDecisionList = TRIAGE_DECISIONS.map((d) => `'${d}'`).join(', ')
  const triageRunStatusList = TRIAGE_RUN_STATUSES.map((s) => `'${s}'`).join(', ')
  const triageReasonList = TRIAGE_REASON_CODES.map((r) => `'${r}'`).join(', ')
  const attemptStatusList = WORKTREE_ATTEMPT_STATUSES.map((s) => `'${s}'`).join(', ')
  const provenanceList = WORKTREE_PROVENANCE_KINDS.map((p) => `'${p}'`).join(', ')
  const worktreeReasonList = WORKTREE_REASON_CODES.map((r) => `'${r}'`).join(', ')
  const verdictList = REVIEW_VERDICTS.map((v) => `'${v}'`).join(', ')

  db.exec(`
    CREATE TABLE IF NOT EXISTS audited_tasks (
      id                          TEXT PRIMARY KEY,
      repo_id                     TEXT NOT NULL,
      source_repo_path            TEXT NOT NULL,
      worktree_id                 TEXT,
      worktree_path               TEXT,
      branch_name                 TEXT,
      base_commit                 TEXT NOT NULL,
      host_id                     TEXT NOT NULL DEFAULT 'local',
      wsl_distro                  TEXT,
      title                       TEXT NOT NULL,
      spec_json                   TEXT NOT NULL,
      source                      TEXT NOT NULL CHECK(source IN (${sourceList})),
      roadmap_entry_id            TEXT,
      risk                        TEXT NOT NULL CHECK(risk IN (${riskList})),
      state                       TEXT NOT NULL CHECK(state IN (${stateList})),
      pre_block_state             TEXT,
      blocked_reason_code         TEXT,
      blocked_phase                TEXT,
      active_phase                TEXT,
      active_lock_binding         TEXT,
      plan_round                  INTEGER NOT NULL DEFAULT 0 CHECK(plan_round BETWEEN 0 AND 3),
      fix_round                   INTEGER NOT NULL DEFAULT 0 CHECK(fix_round BETWEEN 0 AND 3),
      audit_approved_tree_oid     TEXT,
      committed_sha               TEXT,
      landed_sha                  TEXT,
      landed_base_sha             TEXT,
      landing_reason_code         TEXT,
      triage_decision             TEXT CHECK(triage_decision IS NULL OR triage_decision IN (${triageDecisionList})),
      triage_run_status           TEXT CHECK(triage_run_status IS NULL OR triage_run_status IN (${triageRunStatusList})),
      triage_blocked_reason_code  TEXT CHECK(triage_blocked_reason_code IS NULL OR triage_blocked_reason_code IN (${triageReasonList})),
      -- Phase 3. worktree_provenance is NULL until a worktree is actually
      -- verified: it describes a real worktree, never migration history.
      worktree_provenance         TEXT CHECK(worktree_provenance IS NULL OR worktree_provenance IN (${provenanceList})),
      worktree_provisioned_at_ms  INTEGER,
      source_repo_common_dir      TEXT,
      worktree_reason_code        TEXT CHECK(worktree_reason_code IS NULL OR worktree_reason_code IN (${worktreeReasonList})),
      worktree_verified_at_ms     INTEGER,
      -- Phase 5. Denormalized pointer to the task's single 'current' plan
      -- artifact, written in the SAME transaction as the artifact row so the two
      -- can never disagree; audited_plan_artifacts stays the source of truth.
      current_plan_artifact_id    TEXT,
      -- Phase 5. The column behind the long-declared lastVerdict projection
      -- field, which audited-task-service.ts hardcoded to null until now. Uses
      -- the EXISTING ReviewVerdict vocabulary — there is no second verdict union.
      last_verdict                TEXT CHECK(last_verdict IS NULL OR last_verdict IN (${verdictList})),
      created_at_ms                INTEGER NOT NULL,
      updated_at_ms                INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audited_tasks_repo  ON audited_tasks(repo_id);
    CREATE INDEX IF NOT EXISTS idx_audited_tasks_state ON audited_tasks(state);

    CREATE TABLE IF NOT EXISTS audited_transitions (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     TEXT NOT NULL,
      from_state  TEXT,
      to_state    TEXT NOT NULL CHECK(to_state IN (${stateList})),
      actor       TEXT NOT NULL CHECK(actor IN (${actorList})),
      event_type  TEXT NOT NULL,
      reason_code TEXT,
      detail_json TEXT,
      at_ms       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audited_transitions_task ON audited_transitions(task_id, seq);

    -- Phase 2: one row per triage invocation. Raw prompt/response text is
    -- never stored here — only the validated structured fields and enough
    -- bookkeeping to reconcile a run that was interrupted mid-flight. The
    -- Claude-ready prompt and rationale are internal artifacts consumed by
    -- later phases in-process; they are never projected to the renderer.
    CREATE TABLE IF NOT EXISTS audited_triage_runs (
      id                TEXT PRIMARY KEY,
      task_id           TEXT NOT NULL,
      status            TEXT NOT NULL CHECK(status IN (${triageRunStatusList})),
      decision          TEXT CHECK(decision IS NULL OR decision IN (${triageDecisionList})),
      reason_code       TEXT CHECK(reason_code IS NULL OR reason_code IN (${triageReasonList})),
      rationale         TEXT,
      acceptance_criteria_json TEXT,
      next_step_prompt  TEXT,
      started_at_ms     INTEGER NOT NULL,
      ended_at_ms       INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_audited_triage_runs_task ON audited_triage_runs(task_id);
    -- At most one running triage attempt per task, mirroring the
    -- audited_commit_attempts "authorized" partial-unique-index idiom (plan §6) —
    -- this is what makes a duplicate "Start Triage" click a CAS-detectable no-op
    -- rather than a second concurrent provider call.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audited_triage_runs_running
      ON audited_triage_runs(task_id) WHERE status = 'running';

    -- Phase 3: durable provisioning-attempt evidence. The intended_* columns are
    -- written BEFORE any Git command runs, so a crash between "git worktree add"
    -- and SQLite finalization is recoverable by matching on-disk/Git evidence
    -- against exactly what this row says was intended.
    CREATE TABLE IF NOT EXISTS audited_worktree_attempts (
      id                   TEXT PRIMARY KEY,
      task_id              TEXT NOT NULL,
      status               TEXT NOT NULL CHECK(status IN (${attemptStatusList})),
      intended_branch      TEXT NOT NULL,
      intended_path        TEXT NOT NULL,
      intended_base_commit TEXT NOT NULL,
      intended_common_dir  TEXT NOT NULL,
      provenance_id        TEXT NOT NULL,
      reason_code          TEXT CHECK(reason_code IS NULL OR reason_code IN (${worktreeReasonList})),
      claimed_at_ms        INTEGER NOT NULL,
      created_at_ms        INTEGER,
      finalized_at_ms      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_audited_worktree_attempts_task
      ON audited_worktree_attempts(task_id);
    -- At most one live attempt per task: the concurrency primitive that makes a
    -- duplicate Start Triage a CAS-detectable no-op rather than a second worktree.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audited_worktree_attempts_live
      ON audited_worktree_attempts(task_id) WHERE status IN ('claimed','created','verified');

  `)

  createExecutionRunsTable(db)
  createPlanReviewTables(db)
}

// Phase 3 columns added to a pre-existing audited_tasks table, with their
// declared affinities.
const PHASE_3_TASK_COLUMNS: readonly [string, string][] = [
  ['worktree_provenance', 'TEXT'],
  ['worktree_provisioned_at_ms', 'INTEGER'],
  ['source_repo_common_dir', 'TEXT'],
  ['worktree_reason_code', 'TEXT'],
  ['worktree_verified_at_ms', 'INTEGER']
]

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return rows.some((row) => row.name === column)
}

// Why: CREATE TABLE IF NOT EXISTS never alters an existing table's columns —
// createAuditedWorkflowTables always runs first (so a brand-new DB gets every
// column directly), then this function additively ALTERs any pre-existing v1
// audited_tasks table that predates the triage columns. Migrate in a
// transaction that bumps user_version only on success, mirroring
// runtime/orchestration/db.ts's atomic all-or-nothing migration.
export function migrateAuditedWorkflowSchema(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  if (current >= SCHEMA_VERSION) {
    return
  }
  db.exec('BEGIN')
  try {
    if (current < 2) {
      if (!columnExists(db, 'audited_tasks', 'triage_decision')) {
        db.exec(`ALTER TABLE audited_tasks ADD COLUMN triage_decision TEXT`)
      }
      if (!columnExists(db, 'audited_tasks', 'triage_run_status')) {
        db.exec(`ALTER TABLE audited_tasks ADD COLUMN triage_run_status TEXT`)
      }
      if (!columnExists(db, 'audited_tasks', 'triage_blocked_reason_code')) {
        db.exec(`ALTER TABLE audited_tasks ADD COLUMN triage_blocked_reason_code TEXT`)
      }
    }
    if (current < 3) {
      // Why additive-only: Phase 3 adds no task state, so audited_tasks' state
      // CHECK constraint is unchanged and no 12-step table rebuild is required.
      // Every Phase 1/Phase 2 row keeps its rowid and column values untouched.
      // ALTER TABLE ADD COLUMN cannot carry a CHECK constraint; the narrowing
      // CHECKs live in createAuditedWorkflowTables for fresh DBs, and every
      // write site uses typed literals from the closed vocabularies.
      for (const [column, type] of PHASE_3_TASK_COLUMNS) {
        if (!columnExists(db, 'audited_tasks', column)) {
          db.exec(`ALTER TABLE audited_tasks ADD COLUMN ${column} ${type}`)
        }
      }
    }
    if (current < 4) {
      // Phase 4 is a pure table addition — no audited_tasks column, no CHECK
      // change, no rebuild. Created here rather than relying on
      // createAuditedWorkflowTables having run: this function is also called
      // directly against a legacy DB (see audited-task-schema.test.ts), and a
      // migration that silently depends on another call having happened first
      // would leave that path without the table.
      createExecutionRunsTable(db)
    }
    if (current < 5) {
      // Phase 5: two new tables plus two additive task columns. No CHECK change
      // on any existing table and no rebuild — artifact write failures reuse the
      // existing `spawn_failed` execution reason precisely so that stays true.
      // Created here rather than relying on createAuditedWorkflowTables having
      // run: this function is also called directly against a legacy DB, and a
      // migration that silently depends on another call would leave that path
      // without the tables.
      for (const [column, type] of PHASE_5_TASK_COLUMNS) {
        if (!columnExists(db, 'audited_tasks', column)) {
          db.exec(`ALTER TABLE audited_tasks ADD COLUMN ${column} ${type}`)
        }
      }
      createPlanReviewTables(db)
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
