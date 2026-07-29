// Schema DDL and migration for the audited-workflow SQLite database. Kept
// separate from the repository class so schema evolution reviews as its own
// unit — see plan §6 for the full multi-phase schema; Phase 1 creates only
// audited_tasks and audited_transitions.
import {
  AUDITED_TASK_STATES,
  TASK_SOURCES,
  RISK_LEVELS,
  TASK_ACTORS
} from '../../shared/audited-workflow-types'
import type Database from '../sqlite/sync-database'

// Schema versions: v1 initial (audited_tasks, audited_transitions). Later phases
// add audited_candidates / audited_reviews / audited_approvals /
// audited_commit_attempts / audited_phase_runs in their own numbered steps —
// see plan §6. Phase 1 ships only what the vertical slice needs.
export const SCHEMA_VERSION = 1

export function createAuditedWorkflowTables(db: Database.Database): void {
  const stateList = AUDITED_TASK_STATES.map((s) => `'${s}'`).join(', ')
  const sourceList = TASK_SOURCES.map((s) => `'${s}'`).join(', ')
  const riskList = RISK_LEVELS.map((r) => `'${r}'`).join(', ')
  const actorList = TASK_ACTORS.map((a) => `'${a}'`).join(', ')

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
  `)
}

// Why: CREATE TABLE IF NOT EXISTS never alters an existing DB; migrate in a
// transaction that bumps user_version only on success, mirroring
// runtime/orchestration/db.ts's atomic all-or-nothing migration.
export function migrateAuditedWorkflowSchema(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  if (current >= SCHEMA_VERSION) {
    return
  }
  db.exec('BEGIN')
  try {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
