// v9 -> v10 migration (Phase 10).
//
// THE CENTRAL CLAIM: fully additive. `landing` and `landed` have been in
// audited_tasks' state CHECK since Phase 1 — Phase 10 is merely their FIRST
// WRITER — so no table rebuild is required and the long-declared
// landed_sha / landed_base_sha / landing_reason_code columns are left
// structurally untouched.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SCHEMA_VERSION,
  createAuditedWorkflowTables,
  migrateAuditedWorkflowSchema
} from './audited-task-schema'
import Database from '../sqlite/sync-database'

function tableSql(db: Database.Database, name: string): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name) as { sql: string } | undefined
  return row?.sql ?? ''
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name)
}

describe('v10 schema shape', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    createAuditedWorkflowTables(db)
  })

  afterEach(() => db.close())

  it('declares SCHEMA_VERSION 10', () => {
    expect(SCHEMA_VERSION).toBe(10)
  })

  it('creates audited_land_attempts with BOTH bindings', () => {
    const cols = columns(db, 'audited_land_attempts')
    expect(cols).toEqual(
      expect.arrayContaining([
        'commit_attempt_id',
        'publish_attempt_id',
        'intended_sha',
        'intended_base_sha',
        'source_repo_path',
        'source_repo_common_dir',
        'ref_update_started',
        'ref_update_completed',
        'worktree_update_started',
        'worktree_update_completed',
        'landed_sha',
        'landing_advisory'
      ])
    )
  })

  it('enforces at most ONE live attempt per task', () => {
    const idx = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name=?`)
      .get('idx_audited_land_attempts_live') as { sql: string } | undefined
    expect(idx?.sql).toContain("status = 'authorized'")
  })

  it('adds the two Phase 10 task columns', () => {
    const cols = columns(db, 'audited_tasks')
    expect(cols).toContain('land_attempt_status')
    expect(cols).toContain('landing_advisory')
  })

  it('leaves the Phase-1 landing columns in place', () => {
    const cols = columns(db, 'audited_tasks')
    expect(cols).toEqual(
      expect.arrayContaining(['landed_sha', 'landed_base_sha', 'landing_reason_code'])
    )
  })

  it('keeps landing and landed in the state CHECK, unchanged since Phase 1', () => {
    const sql = tableSql(db, 'audited_tasks')
    expect(sql).toContain("'landing'")
    expect(sql).toContain("'landed'")
  })
})

describe('v9 -> v10 is additive and produces an identical table', () => {
  it('migrates a v9 database without rebuilding audited_tasks', () => {
    const migrated = new Database(':memory:')
    createAuditedWorkflowTables(migrated)
    // Simulate a v9 database: drop the Phase 10 table and pretend the version is 9.
    migrated.exec(`DROP TABLE audited_land_attempts`)
    migrated.exec(`PRAGMA user_version = 9`)
    const tasksBefore = tableSql(migrated, 'audited_tasks')

    migrateAuditedWorkflowSchema(migrated)

    expect(migrated.pragma('user_version', { simple: true })).toBe(10)
    // The tasks table was NOT rebuilt.
    expect(tableSql(migrated, 'audited_tasks')).toBe(tasksBefore)

    const fresh = new Database(':memory:')
    createAuditedWorkflowTables(fresh)
    expect(tableSql(migrated, 'audited_land_attempts')).toBe(
      tableSql(fresh, 'audited_land_attempts')
    )

    migrated.close()
    fresh.close()
  })

  it('preserves existing rows across the migration', () => {
    const db = new Database(':memory:')
    createAuditedWorkflowTables(db)
    db.prepare(
      `INSERT INTO audited_tasks
         (id, repo_id, source_repo_path, base_commit, host_id, title, spec_json, source, risk,
          state, committed_sha, created_at_ms, updated_at_ms)
       VALUES ('t1','r1','/repo',?, 'local','t','{}','custom','low','committed',?,1,1)`
    ).run('b'.repeat(40), 'c'.repeat(40))
    db.exec(`DROP TABLE audited_land_attempts`)
    db.exec(`PRAGMA user_version = 9`)

    migrateAuditedWorkflowSchema(db)

    const row = db.prepare(`SELECT state, committed_sha FROM audited_tasks WHERE id='t1'`).get() as
      | { state: string; committed_sha: string }
      | undefined
    expect(row?.state).toBe('committed')
    expect(row?.committed_sha).toBe('c'.repeat(40))
    db.close()
  })

  it('is a no-op when already at v10', () => {
    const db = new Database(':memory:')
    createAuditedWorkflowTables(db)
    db.exec(`PRAGMA user_version = 10`)
    const before = tableSql(db, 'audited_land_attempts')
    migrateAuditedWorkflowSchema(db)
    expect(tableSql(db, 'audited_land_attempts')).toBe(before)
    db.close()
  })
})
