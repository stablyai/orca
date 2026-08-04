// Phase 6 schema migration: v5 -> v6 is a PURE TABLE ADDITION, and the most
// additive yet — it adds no audited_tasks column at all, because current coverage
// is DERIVED rather than denormalized onto the task.
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

describe('v6 schema', () => {
  it('stamps a fresh database with the current schema version', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(6)
    const db = freshDb()
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    db.close()
  })

  it('creates audited_plan_coverage with its key and CHECK', () => {
    const db = freshDb()
    const sql = tableSql(db, 'audited_plan_coverage')
    expect(sql).toContain('audited_plan_coverage')
    expect(sql).toContain('PRIMARY KEY (run_id, criterion_id)')
    expect(sql).toMatch(/covered\s+INTEGER NOT NULL CHECK\(covered IN \(0, 1\)\)/)
    db.close()
  })

  it('rejects a covered value outside 0/1', () => {
    const db = freshDb()
    expect(() =>
      db
        .prepare(
          `INSERT INTO audited_plan_coverage (run_id, task_id, criterion_id, covered, created_at_ms)
           VALUES ('r', 't', 'ac1', 2, 1)`
        )
        .run()
    ).toThrow()
    db.close()
  })

  it('rejects a duplicate criterion within one run', () => {
    const db = freshDb()
    const insert = (criterion: string): void => {
      db.prepare(
        `INSERT INTO audited_plan_coverage (run_id, task_id, criterion_id, covered, created_at_ms)
         VALUES ('r', 't', ?, 1, 1)`
      ).run(criterion)
    }
    insert('ac1')
    expect(() => insert('ac1')).toThrow()
    db.close()
  })
})

describe('v5 -> v6 is additive', () => {
  it('leaves the audited_tasks state CHECK untouched (no rebuild)', () => {
    const before = new SyncDatabase(':memory:')
    createAuditedWorkflowTables(before)
    const sqlBefore = tableSql(before, 'audited_tasks')
    before.close()

    const after = freshDb()
    expect(tableSql(after, 'audited_tasks')).toBe(sqlBefore)
    after.close()
  })

  // The distinguishing property of this phase: no denormalized pointer exists, so
  // nothing on the task can disagree with the coverage rows.
  it('adds no audited_tasks column', () => {
    const db = freshDb()
    const columns = (
      db.prepare(`PRAGMA table_info(audited_tasks)`).all() as { name: string }[]
    ).map((c) => c.name)
    expect(columns).not.toContain('coverage_json')
    expect(columns).not.toContain('coverage_available')
    expect(columns).not.toContain('current_coverage_run_id')
    db.close()
  })

  it('leaves audited_plan_review_runs unchanged', () => {
    const before = new SyncDatabase(':memory:')
    createAuditedWorkflowTables(before)
    const sqlBefore = tableSql(before, 'audited_plan_review_runs')
    before.close()

    const after = freshDb()
    expect(tableSql(after, 'audited_plan_review_runs')).toBe(sqlBefore)
    after.close()
  })

  it('preserves existing rows and pointers across the migration', () => {
    const db = new SyncDatabase(':memory:')
    createAuditedWorkflowTables(db)
    db.exec('DROP TABLE audited_plan_coverage')
    db.pragma('user_version = 5')
    db.prepare(
      `INSERT INTO audited_tasks
         (id, repo_id, source_repo_path, base_commit, host_id, title, spec_json, source, risk,
          state, plan_round, fix_round, current_plan_artifact_id, last_verdict,
          created_at_ms, updated_at_ms)
       VALUES ('t1', 'r', '/p', 'abc', 'local', 'T', '{}', 'custom', 'low',
               'awaiting_plan_review', 1, 0, 'plan_x', 'approved', 1, 1)`
    ).run()

    migrateAuditedWorkflowSchema(db)

    expect(db.prepare(`SELECT * FROM audited_tasks WHERE id = 't1'`).get()).toMatchObject({
      state: 'awaiting_plan_review',
      plan_round: 1,
      current_plan_artifact_id: 'plan_x',
      last_verdict: 'approved'
    })
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
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
    // having run first — it is also invoked directly against a legacy DB.
    const db = new SyncDatabase(':memory:')
    createAuditedWorkflowTables(db)
    db.exec('DROP TABLE audited_plan_coverage')
    db.pragma('user_version = 5')

    migrateAuditedWorkflowSchema(db)

    expect(tableSql(db, 'audited_plan_coverage')).toContain('audited_plan_coverage')
    db.close()
  })

  // A v5 database has zero coverage rows. That must read as "unknown", never as
  // "nothing is covered" — the distinction the projection carries separately.
  it('leaves a migrated legacy database with no coverage rows', () => {
    const db = new SyncDatabase(':memory:')
    createAuditedWorkflowTables(db)
    db.exec('DROP TABLE audited_plan_coverage')
    db.pragma('user_version = 5')

    migrateAuditedWorkflowSchema(db)

    expect(db.prepare(`SELECT COUNT(*) as n FROM audited_plan_coverage`).get()).toEqual({ n: 0 })
    db.close()
  })
})
