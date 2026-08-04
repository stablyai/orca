// Phase 4 schema migration: v3 -> v4 is a PURE TABLE ADDITION. Phase 4 adds no
// task state — its one new transition rule (cancelImplementation) is TypeScript,
// and the database has no notion of transition legality — so audited_tasks'
// state CHECK is unchanged and no 12-step table rebuild is required.
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

describe('v4 schema', () => {
  // Asserts the CURRENT version rather than a literal 4: this suite owns the
  // Phase 4 tables, not the version number, and later phases legitimately bump
  // it (v5 added the plan-review tables). Pinning a literal here would make
  // every future phase edit an unrelated Phase 4 test.
  it('stamps a fresh database with the current schema version', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(4)
    const db = freshDb()
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    db.close()
  })

  it('creates audited_execution_runs with its CHECK constraints', () => {
    const db = freshDb()
    const sql = tableSql(db, 'audited_execution_runs')
    expect(sql).toContain('pre_launch_state')
    expect(sql).toContain('active_run_state')
    expect(sql).toContain("mode IN ('plan', 'direct')")
    db.close()
  })

  it('enforces at most one running run per task', () => {
    const db = freshDb()
    const insert = (id: string): void => {
      db.prepare(
        `INSERT INTO audited_execution_runs
           (id, task_id, mode, status, pre_launch_state, active_run_state,
            worktree_verified_at_ms, started_at_ms)
         VALUES (?, 't1', 'plan', 'running', 'planning', 'planning', 1, 1)`
      ).run(id)
    }
    insert('a')
    expect(() => insert('b')).toThrow()
    db.close()
  })

  it('rejects an out-of-vocabulary status, mode, or state', () => {
    const db = freshDb()
    const insertWith = (mode: string, status: string, preLaunch: string): void => {
      db.prepare(
        `INSERT INTO audited_execution_runs
           (id, task_id, mode, status, pre_launch_state, active_run_state,
            worktree_verified_at_ms, started_at_ms)
         VALUES ('x', 't', ?, ?, ?, 'planning', 1, 1)`
      ).run(mode, status, preLaunch)
    }
    expect(() => insertWith('bogus', 'running', 'planning')).toThrow()
    expect(() => insertWith('plan', 'bogus', 'planning')).toThrow()
    // implementing is an ACTIVE run state, never a pre-launch one.
    expect(() => insertWith('plan', 'running', 'implementing')).toThrow()
    db.close()
  })
})

describe('v3 -> v4 is additive', () => {
  it('leaves the audited_tasks state CHECK untouched (no rebuild)', () => {
    const before = new SyncDatabase(':memory:')
    createAuditedWorkflowTables(before)
    const sqlBefore = tableSql(before, 'audited_tasks')
    before.close()

    const after = freshDb()
    expect(tableSql(after, 'audited_tasks')).toBe(sqlBefore)
    after.close()
  })

  it('adds no audited_tasks column', () => {
    const db = freshDb()
    const columns = (
      db.prepare(`PRAGMA table_info(audited_tasks)`).all() as { name: string }[]
    ).map((c) => c.name)
    expect(columns).not.toContain('execution_run_status')
    expect(columns).not.toContain('execution_reason_code')
    db.close()
  })

  it('leaves audited_transitions.event_type unconstrained, so execution_* needs no migration', () => {
    const db = freshDb()
    const sql = tableSql(db, 'audited_transitions')
    expect(sql).toContain('event_type  TEXT NOT NULL')
    expect(sql).not.toMatch(/event_type[^,]*CHECK/)

    db.prepare(
      `INSERT INTO audited_transitions
         (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES ('t', 'implementing', 'ready_to_implement', 'human', 'execution_cancelled', 'cancelled_by_user', NULL, 1)`
    ).run()
    db.close()
  })

  it('preserves existing rows across the migration', () => {
    const db = new SyncDatabase(':memory:')
    createAuditedWorkflowTables(db)
    db.pragma('user_version = 3')
    db.prepare(
      `INSERT INTO audited_tasks
         (id, repo_id, source_repo_path, base_commit, host_id, title, spec_json, source, risk,
          state, plan_round, fix_round, created_at_ms, updated_at_ms)
       VALUES ('t1', 'r', '/p', 'abc', 'local', 'T', '{}', 'custom', 'low', 'selected', 0, 0, 1, 1)`
    ).run()

    migrateAuditedWorkflowSchema(db)

    const row = db.prepare(`SELECT * FROM audited_tasks WHERE id = 't1'`).get() as {
      state: string
      title: string
    }
    expect(row.state).toBe('selected')
    expect(row.title).toBe('T')
    db.close()
  })

  it('is a no-op when re-run', () => {
    const db = freshDb()
    expect(() => migrateAuditedWorkflowSchema(db)).not.toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    db.close()
  })

  it('creates the table even when called on a legacy DB directly', () => {
    // The migration must not silently depend on createAuditedWorkflowTables
    // having run first.
    const db = new SyncDatabase(':memory:')
    createAuditedWorkflowTables(db)
    db.exec('DROP TABLE audited_execution_runs')
    db.pragma('user_version = 3')

    migrateAuditedWorkflowSchema(db)

    expect(tableSql(db, 'audited_execution_runs')).toContain('audited_execution_runs')
    db.close()
  })
})
