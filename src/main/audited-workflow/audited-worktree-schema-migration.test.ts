// Proves the Phase 3 migration is additive and preserves every Phase 1/Phase 2
// row. Phase 3 adds no task state, so audited_tasks' CHECK constraint is
// unchanged and no table rebuild occurs — asserted via stable rowids.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import {
  SCHEMA_VERSION,
  createAuditedWorkflowTables,
  migrateAuditedWorkflowSchema
} from './audited-task-schema'

const dirs: string[] = []

function newDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-audited-mig-'))
  dirs.push(dir)
  return join(dir, 'audited.db')
}

afterEach(() => {
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop() as string, { recursive: true, force: true })
    } catch {
      // Leaked temp dirs are harmless.
    }
  }
})

/** A v2 database with representative Phase 1 + Phase 2 rows. */
function seedV2Database(path: string): void {
  const db = new Database(path)
  db.exec(`
    CREATE TABLE audited_tasks (
      id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, source_repo_path TEXT NOT NULL,
      worktree_id TEXT, worktree_path TEXT, branch_name TEXT, base_commit TEXT NOT NULL,
      host_id TEXT NOT NULL DEFAULT 'local', wsl_distro TEXT, title TEXT NOT NULL,
      spec_json TEXT NOT NULL, source TEXT NOT NULL, roadmap_entry_id TEXT,
      risk TEXT NOT NULL, state TEXT NOT NULL, pre_block_state TEXT,
      blocked_reason_code TEXT, blocked_phase TEXT, active_phase TEXT,
      active_lock_binding TEXT, plan_round INTEGER NOT NULL DEFAULT 0,
      fix_round INTEGER NOT NULL DEFAULT 0, audit_approved_tree_oid TEXT,
      committed_sha TEXT, landed_sha TEXT, landed_base_sha TEXT, landing_reason_code TEXT,
      triage_decision TEXT, triage_run_status TEXT, triage_blocked_reason_code TEXT,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE audited_transitions (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, from_state TEXT,
      to_state TEXT NOT NULL, actor TEXT NOT NULL, event_type TEXT NOT NULL,
      reason_code TEXT, detail_json TEXT, at_ms INTEGER NOT NULL
    );
    CREATE TABLE audited_triage_runs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL, decision TEXT,
      reason_code TEXT, rationale TEXT, acceptance_criteria_json TEXT,
      next_step_prompt TEXT, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER
    );
    INSERT INTO audited_tasks (id, repo_id, source_repo_path, base_commit, title, spec_json,
      source, risk, state, triage_decision, triage_run_status, created_at_ms, updated_at_ms)
    VALUES ('audited_p1', 'repo1', '/repos/one', 'aaa', 'Phase 1 task', '{}', 'custom', 'low',
      'selected', NULL, NULL, 100, 100),
      ('audited_p2', 'repo2', '/repos/two', 'bbb', 'Phase 2 task', '{}', 'roadmap', 'high',
      'ready_to_implement', 'direct', 'succeeded', 200, 250);
    INSERT INTO audited_transitions (task_id, from_state, to_state, actor, event_type, at_ms)
    VALUES ('audited_p1', NULL, 'selected', 'human', 'task_created', 100),
      ('audited_p2', 'triaging', 'ready_to_implement', 'triage', 'triage_direct', 250);
    INSERT INTO audited_triage_runs (id, task_id, status, decision, rationale, started_at_ms, ended_at_ms)
    VALUES ('triage_1', 'audited_p2', 'succeeded', 'direct', 'Trivial change', 200, 250);
    PRAGMA user_version = 2;
  `)
  db.close()
}

function snapshot(db: Database.Database, table: string): Record<string, unknown>[] {
  return db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all() as Record<
    string,
    unknown
  >[]
}

describe('v2 -> v3 migration', () => {
  it('preserves every Phase 1 and Phase 2 row, including rowids (no table rebuild)', () => {
    const path = newDbPath()
    seedV2Database(path)

    const before = new Database(path)
    const tasksBefore = snapshot(before, 'audited_tasks')
    const transitionsBefore = snapshot(before, 'audited_transitions')
    const runsBefore = snapshot(before, 'audited_triage_runs')
    before.close()

    const db = new Database(path)
    createAuditedWorkflowTables(db)
    migrateAuditedWorkflowSchema(db)

    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)

    const tasksAfter = snapshot(db, 'audited_tasks')
    // Every pre-existing column value survives untouched...
    for (const [index, before] of tasksBefore.entries()) {
      for (const [key, value] of Object.entries(before)) {
        expect(tasksAfter[index][key], `${key} changed`).toEqual(value)
      }
    }
    // ...and rowids are stable, which a 12-step rebuild would not preserve.
    expect(tasksAfter.map((row) => row.rowid)).toEqual(tasksBefore.map((row) => row.rowid))
    expect(snapshot(db, 'audited_transitions')).toEqual(transitionsBefore)
    expect(snapshot(db, 'audited_triage_runs')).toEqual(runsBefore)
    db.close()
  })

  it('adds the Phase 3 columns as NULL rather than inventing provenance', () => {
    const path = newDbPath()
    seedV2Database(path)
    const db = new Database(path)
    createAuditedWorkflowTables(db)
    migrateAuditedWorkflowSchema(db)

    const rows = db
      .prepare(
        `SELECT worktree_provenance, worktree_reason_code, source_repo_common_dir,
                worktree_provisioned_at_ms, worktree_verified_at_ms FROM audited_tasks`
      )
      .all() as Record<string, unknown>[]

    for (const row of rows) {
      // A task with no worktree must NOT be labelled with any provenance.
      expect(row.worktree_provenance).toBeNull()
      expect(row.worktree_reason_code).toBeNull()
      expect(row.source_repo_common_dir).toBeNull()
      expect(row.worktree_provisioned_at_ms).toBeNull()
      expect(row.worktree_verified_at_ms).toBeNull()
    }
    db.close()
  })

  it('creates audited_worktree_attempts with the live-attempt uniqueness index', () => {
    const path = newDbPath()
    seedV2Database(path)
    const db = new Database(path)
    createAuditedWorkflowTables(db)
    migrateAuditedWorkflowSchema(db)

    const insert = (id: string, status: string): void => {
      db.prepare(
        `INSERT INTO audited_worktree_attempts (id, task_id, status, intended_branch,
           intended_path, intended_base_commit, intended_common_dir, provenance_id, claimed_at_ms)
         VALUES (?, 'audited_p1', ?, 'b', '/p', 'aaa', '/c', 'prov', 1)`
      ).run(id, status)
    }
    insert('attempt_1', 'claimed')

    // A second LIVE attempt for the same task is rejected...
    expect(() => insert('attempt_2', 'created')).toThrow()
    // ...but a terminal one is allowed, so history is retained.
    expect(() => insert('attempt_3', 'failed_ambiguous')).not.toThrow()
    db.close()
  })

  it('is idempotent and safe to run repeatedly', () => {
    const path = newDbPath()
    seedV2Database(path)
    const db = new Database(path)
    createAuditedWorkflowTables(db)
    migrateAuditedWorkflowSchema(db)
    const first = snapshot(db, 'audited_tasks')

    migrateAuditedWorkflowSchema(db)
    migrateAuditedWorkflowSchema(db)

    expect(snapshot(db, 'audited_tasks')).toEqual(first)
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    db.close()
  })
})
