// Phase 7 schema migration.
//
// v6 -> v7 is the FIRST non-additive step in this feature's history: a `fix` run
// lives in code_fixes_requested -> awaiting_code_audit, which
// audited_execution_runs' two state CHECKs exclude, and SQLite cannot ALTER a
// CHECK. M1 is therefore the load-bearing test — it proves the rebuild preserves
// every row, both indexes, and every constraint that was NOT meant to change.
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') }
}))

import SyncDatabase from '../sqlite/sync-database'
import {
  createAuditedWorkflowTables,
  migrateAuditedWorkflowSchema,
  SCHEMA_VERSION
} from './audited-task-schema'

function freshDb(): SyncDatabase.Database {
  const db = new SyncDatabase(':memory:')
  createAuditedWorkflowTables(db)
  migrateAuditedWorkflowSchema(db)
  return db
}

function tableSql(db: SyncDatabase.Database, table: string): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string } | undefined
  return row?.sql ?? ''
}

function indexNames(db: SyncDatabase.Database, table: string): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`)
      .all(table) as { name: string }[]
  )
    .map((row) => row.name)
    .filter((name) => name.startsWith('idx_'))
    .sort()
}

/** A v6 database: Phase 7 objects removed, execution CHECKs at their old width. */
function legacyV6Db(): SyncDatabase.Database {
  const db = new SyncDatabase(':memory:')
  createAuditedWorkflowTables(db)
  db.exec('DROP TABLE audited_candidates')
  db.exec('DROP TABLE audited_code_audit_runs')
  db.exec('DROP TABLE audited_execution_runs')
  db.exec(`
    CREATE TABLE audited_execution_runs (
      id                TEXT PRIMARY KEY,
      task_id           TEXT NOT NULL,
      mode              TEXT NOT NULL CHECK(mode IN ('plan', 'direct')),
      status            TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','cancelled','interrupted','blocked')),
      pre_launch_state  TEXT NOT NULL CHECK(pre_launch_state IN ('planning','ready_to_implement')),
      active_run_state  TEXT NOT NULL CHECK(active_run_state IN ('planning','implementing')),
      reason_code       TEXT,
      exit_code         INTEGER,
      stdout_bytes      INTEGER NOT NULL DEFAULT 0,
      stderr_bytes      INTEGER NOT NULL DEFAULT 0,
      output_truncated  INTEGER NOT NULL DEFAULT 0,
      worktree_verified_at_ms INTEGER NOT NULL,
      started_at_ms     INTEGER NOT NULL,
      ended_at_ms       INTEGER
    );
    CREATE INDEX idx_audited_execution_runs_task ON audited_execution_runs(task_id);
    CREATE UNIQUE INDEX idx_audited_execution_runs_running
      ON audited_execution_runs(task_id) WHERE status = 'running';
  `)
  db.pragma('user_version = 6')
  return db
}

function insertExecutionRun(
  db: SyncDatabase.Database,
  id: string,
  overrides: Partial<{
    taskId: string
    status: string
    mode: string
    pre: string
    active: string
  }> = {}
): void {
  db.prepare(
    `INSERT INTO audited_execution_runs
       (id, task_id, mode, status, pre_launch_state, active_run_state,
        stdout_bytes, stderr_bytes, output_truncated, worktree_verified_at_ms, started_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, 11, 22, 1, 99, 1234)`
  ).run(
    id,
    overrides.taskId ?? 't1',
    overrides.mode ?? 'direct',
    overrides.status ?? 'succeeded',
    overrides.pre ?? 'ready_to_implement',
    overrides.active ?? 'implementing'
  )
}

describe('v7 schema', () => {
  it('stamps a fresh database with the current schema version', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(7)
    const db = freshDb()
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    db.close()
  })

  it('creates audited_candidates with its ownership constraints', () => {
    const db = freshDb()
    const sql = tableSql(db, 'audited_candidates')
    expect(sql).toContain('UNIQUE(run_id)')
    expect(sql).toMatch(/status\s+TEXT NOT NULL CHECK\(status IN \('current', 'superseded'\)\)/)
    expect(indexNames(db, 'audited_candidates')).toContain('idx_audited_candidates_current')
    db.close()
  })

  it('enforces one current candidate and one candidate per run', () => {
    const db = freshDb()
    const insert = (id: string, runId: string, status: string): void => {
      db.prepare(
        `INSERT INTO audited_candidates
           (id, task_id, run_id, round, status, tree_oid, base_commit, branch_name, created_at_ms)
         VALUES (?, 't1', ?, 0, ?, 'a', 'b', 'br', 1)`
      ).run(id, runId, status)
    }
    insert('c1', 'r1', 'current')
    expect(() => insert('c2', 'r2', 'current')).toThrow() // one 'current' per task
    expect(() => insert('c3', 'r1', 'superseded')).toThrow() // one candidate per run
    db.close()
  })

  it('enforces at most one running code audit per task', () => {
    const db = freshDb()
    const insert = (id: string): void => {
      db.prepare(
        `INSERT INTO audited_code_audit_runs
           (id, task_id, candidate_id, candidate_tree_oid, round, status,
            worktree_verified_at_ms, started_at_ms)
         VALUES (?, 't1', 'c1', 'a', 0, 'running', 1, 1)`
      ).run(id)
    }
    insert('a1')
    expect(() => insert('a2')).toThrow()
    db.close()
  })
})

describe('v6 -> v7 execution-runs rebuild', () => {
  // M1 — the load-bearing test.
  it('preserves every row, column value, and index across the rebuild', () => {
    const db = legacyV6Db()
    insertExecutionRun(db, 'run_a', { taskId: 't1', status: 'succeeded' })
    insertExecutionRun(db, 'run_b', {
      taskId: 't2',
      status: 'blocked',
      mode: 'plan',
      pre: 'planning',
      active: 'planning'
    })
    const before = db.prepare(`SELECT * FROM audited_execution_runs ORDER BY id`).all() as Record<
      string,
      unknown
    >[]
    const indexesBefore = indexNames(db, 'audited_execution_runs')

    migrateAuditedWorkflowSchema(db)

    expect(db.prepare(`SELECT * FROM audited_execution_runs ORDER BY id`).all()).toEqual(before)
    expect(indexNames(db, 'audited_execution_runs')).toEqual(indexesBefore)
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    db.close()
  })

  it('keeps the running-unique index ENFORCING after the rebuild', () => {
    const db = legacyV6Db()
    migrateAuditedWorkflowSchema(db)

    insertExecutionRun(db, 'run_1', { status: 'running' })
    expect(() => insertExecutionRun(db, 'run_2', { status: 'running' })).toThrow()
    // A terminal run does not occupy the slot.
    expect(() => insertExecutionRun(db, 'run_3', { status: 'failed' })).not.toThrow()
    db.close()
  })

  // The whole point of the rebuild.
  it('accepts fix-lane states after the rebuild and rejected them before', () => {
    const db = legacyV6Db()
    expect(() =>
      insertExecutionRun(db, 'pre', {
        mode: 'fix',
        pre: 'code_fixes_requested',
        active: 'awaiting_code_audit'
      })
    ).toThrow()

    migrateAuditedWorkflowSchema(db)

    expect(() =>
      insertExecutionRun(db, 'post', {
        mode: 'fix',
        pre: 'code_fixes_requested',
        active: 'awaiting_code_audit'
      })
    ).not.toThrow()
    db.close()
  })

  // The rebuild must not silently narrow anything it was not meant to change.
  it('preserves the status vocabulary, including `blocked`', () => {
    const db = legacyV6Db()
    migrateAuditedWorkflowSchema(db)

    expect(() => insertExecutionRun(db, 'b', { status: 'blocked' })).not.toThrow()
    expect(() => insertExecutionRun(db, 'x', { status: 'bogus' })).toThrow()
    expect(() => insertExecutionRun(db, 'y', { mode: 'bogus' })).toThrow()
    // A state outside the widened set is still refused.
    expect(() => insertExecutionRun(db, 'z', { active: 'committing' })).toThrow()
    db.close()
  })

  it('does not rebuild a database that already has the widened CHECKs', () => {
    const db = freshDb()
    const sqlBefore = tableSql(db, 'audited_execution_runs')
    insertExecutionRun(db, 'run_a')

    migrateAuditedWorkflowSchema(db)

    expect(tableSql(db, 'audited_execution_runs')).toBe(sqlBefore)
    expect(db.prepare(`SELECT COUNT(*) as n FROM audited_execution_runs`).get()).toEqual({ n: 1 })
    db.close()
  })
})

describe('v6 -> v7 is otherwise additive', () => {
  // M2
  it('leaves the audited_tasks state CHECK untouched (no task-table rebuild)', () => {
    const before = new SyncDatabase(':memory:')
    createAuditedWorkflowTables(before)
    const stateCheck = /state\s+TEXT NOT NULL CHECK\(state IN \([^)]*\)\)/.exec(
      tableSql(before, 'audited_tasks')
    )?.[0]
    before.close()

    const after = freshDb()
    expect(
      /state\s+TEXT NOT NULL CHECK\(state IN \([^)]*\)\)/.exec(
        tableSql(after, 'audited_tasks')
      )?.[0]
    ).toBe(stateCheck)
    after.close()
  })

  it.each([
    'audited_plan_artifacts',
    'audited_plan_review_runs',
    'audited_plan_coverage',
    'audited_transitions'
  ])('leaves %s unchanged', (table) => {
    const before = new SyncDatabase(':memory:')
    createAuditedWorkflowTables(before)
    const sqlBefore = tableSql(before, table)
    before.close()

    const after = freshDb()
    expect(tableSql(after, table)).toBe(sqlBefore)
    after.close()
  })

  it('preserves task rows and pointers across the migration', () => {
    const db = legacyV6Db()
    db.prepare(
      `INSERT INTO audited_tasks
         (id, repo_id, source_repo_path, base_commit, host_id, title, spec_json, source, risk,
          state, plan_round, fix_round, current_plan_artifact_id, last_verdict,
          created_at_ms, updated_at_ms)
       VALUES ('t1', 'r', '/p', 'abc', 'local', 'T', '{}', 'custom', 'low',
               'awaiting_code_audit', 1, 2, 'plan_x', 'approved', 1, 1)`
    ).run()

    migrateAuditedWorkflowSchema(db)

    expect(db.prepare(`SELECT * FROM audited_tasks WHERE id = 't1'`).get()).toMatchObject({
      state: 'awaiting_code_audit',
      fix_round: 2,
      current_plan_artifact_id: 'plan_x',
      last_verdict: 'approved',
      current_candidate_id: null,
      code_audit_verdict: null
    })
    db.close()
  })

  // M3
  it('creates both tables when called on a legacy DB directly, and is a no-op re-run', () => {
    const db = legacyV6Db()

    migrateAuditedWorkflowSchema(db)
    expect(tableSql(db, 'audited_candidates')).toContain('audited_candidates')
    expect(tableSql(db, 'audited_code_audit_runs')).toContain('audited_code_audit_runs')

    expect(() => migrateAuditedWorkflowSchema(db)).not.toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    db.close()
  })

  it('leaves a migrated legacy database with no candidates or audit runs', () => {
    const db = legacyV6Db()
    migrateAuditedWorkflowSchema(db)

    expect(db.prepare(`SELECT COUNT(*) as n FROM audited_candidates`).get()).toEqual({ n: 0 })
    expect(db.prepare(`SELECT COUNT(*) as n FROM audited_code_audit_runs`).get()).toEqual({ n: 0 })
    db.close()
  })
})
