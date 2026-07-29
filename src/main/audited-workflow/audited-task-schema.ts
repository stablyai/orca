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
import type Database from '../sqlite/sync-database'

// Schema versions: v1 initial (audited_tasks, audited_transitions). v2 (Phase 2)
// adds audited_triage_runs plus triage status columns on audited_tasks. Later
// phases add audited_candidates / audited_reviews / audited_approvals /
// audited_commit_attempts / audited_phase_runs in their own numbered steps —
// see plan §6.
export const SCHEMA_VERSION = 2

export function createAuditedWorkflowTables(db: Database.Database): void {
  const stateList = AUDITED_TASK_STATES.map((s) => `'${s}'`).join(', ')
  const sourceList = TASK_SOURCES.map((s) => `'${s}'`).join(', ')
  const riskList = RISK_LEVELS.map((r) => `'${r}'`).join(', ')
  const actorList = TASK_ACTORS.map((a) => `'${a}'`).join(', ')
  const triageDecisionList = TRIAGE_DECISIONS.map((d) => `'${d}'`).join(', ')
  const triageRunStatusList = TRIAGE_RUN_STATUSES.map((s) => `'${s}'`).join(', ')
  const triageReasonList = TRIAGE_REASON_CODES.map((r) => `'${r}'`).join(', ')

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
  `)
}

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
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
