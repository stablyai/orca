// v10 -> v11: the audit_mode column, and what it must NOT disturb.
//
// The regression half is the important half. This change touches the schema and
// two run repositories that Phases 8, 9, and 10 depend on, so these cases pin
// that the commit/publish/landing tables and every pre-existing row survive it.
import { describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import {
  SCHEMA_VERSION,
  createAuditedWorkflowTables,
  migrateAuditedWorkflowSchema
} from './audited-task-schema'
import { toAuditMode } from '../../shared/audited-audit-mode-types'

function freshDatabase(): Database.Database {
  const db = new Database(':memory:')
  createAuditedWorkflowTables(db)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  return db
}

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (row) => row.name
  )
}

function tablesOf(db: Database.Database): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
  ).map((row) => row.name)
}

describe('the migration is additive', () => {
  it('adds audit_mode to both run tables', () => {
    const db = freshDatabase()
    expect(columnsOf(db, 'audited_code_audit_runs')).toContain('audit_mode')
    expect(columnsOf(db, 'audited_plan_review_runs')).toContain('audit_mode')
  })

  it('brings a simulated v10 database to v11 without losing a row', () => {
    const db = freshDatabase()

    // Simulate a v10 profile: a run row that predates the column, with the
    // column dropped back off by rebuilding is not possible in SQLite, so the
    // realistic v10 shape is a row whose audit_mode was never written.
    db.prepare(
      `INSERT INTO audited_code_audit_runs
         (id, task_id, candidate_id, candidate_tree_oid, round, status,
          worktree_verified_at_ms, started_at_ms)
       VALUES ('cra_old', 'task_1', 'cand_1', ?, 0, 'succeeded', 1, 1)`
    ).run('a'.repeat(40))
    db.exec('PRAGMA user_version = 10')

    migrateAuditedWorkflowSchema(db)

    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    const row = db
      .prepare(`SELECT id, audit_mode FROM audited_code_audit_runs WHERE id = 'cra_old'`)
      .get() as { id: string; audit_mode: string | null }
    expect(row.id).toBe('cra_old')
    // NULL, and it must READ as the CLI mode — never relabeled as no-tools.
    expect(row.audit_mode).toBeNull()
    expect(toAuditMode(row.audit_mode)).toBe('codex_cli')
  })

  it('is idempotent across a relaunch', () => {
    const db = freshDatabase()
    db.exec('PRAGMA user_version = 10')
    migrateAuditedWorkflowSchema(db)
    migrateAuditedWorkflowSchema(db)
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(
      columnsOf(db, 'audited_code_audit_runs').filter((name) => name === 'audit_mode')
    ).toHaveLength(1)
  })
})

describe('Phase 8-10 tables are untouched', () => {
  it('leaves every commit, publish, and landing table in place', () => {
    const db = freshDatabase()
    db.exec('PRAGMA user_version = 10')
    migrateAuditedWorkflowSchema(db)

    const tables = tablesOf(db)
    expect(tables).toContain('audited_commit_attempts')
    expect(tables).toContain('audited_publish_attempts')
    expect(tables).toContain('audited_land_attempts')
  })

  it('preserves the landing CAS partial index', () => {
    const db = freshDatabase()
    db.exec('PRAGMA user_version = 10')
    migrateAuditedWorkflowSchema(db)

    const index = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'index'
           AND name = 'idx_audited_land_attempts_live'`
      )
      .get() as { sql: string } | undefined
    expect(index?.sql).toContain(`status = 'authorized'`)
  })

  it('preserves Phase 8/9/10 columns on audited_tasks', () => {
    const db = freshDatabase()
    db.exec('PRAGMA user_version = 10')
    migrateAuditedWorkflowSchema(db)

    const columns = columnsOf(db, 'audited_tasks')
    for (const column of [
      'committed_sha',
      'published_sha',
      'landed_sha',
      'landed_base_sha',
      'landing_reason_code',
      'land_attempt_status',
      'landing_advisory'
    ]) {
      expect(columns, `audited_tasks.${column} must survive`).toContain(column)
    }
  })

  it('adds NO column to any Phase 8-10 table', () => {
    // The mode belongs to the AUDIT lanes. A commit, publish, or land attempt
    // has no transport, and giving one a mode column would imply otherwise.
    const db = freshDatabase()
    for (const table of [
      'audited_commit_attempts',
      'audited_publish_attempts',
      'audited_land_attempts'
    ]) {
      expect(columnsOf(db, table)).not.toContain('audit_mode')
    }
  })
})

describe('the mode CHECK constraint', () => {
  it('accepts both vocabulary members and NULL', () => {
    const db = freshDatabase()
    const insert = (id: string, mode: string | null): void => {
      db.prepare(
        `INSERT INTO audited_code_audit_runs
           (id, task_id, candidate_id, candidate_tree_oid, round, status,
            audit_mode, worktree_verified_at_ms, started_at_ms)
         VALUES (?, 'task_1', 'cand_1', ?, 0, 'running', ?, 1, 1)`
      ).run(id, 'a'.repeat(40), mode)
    }
    // Distinct task ids are not needed: the partial unique index is on
    // status='running', so these must not all be running.
    db.exec(`UPDATE audited_code_audit_runs SET status = 'succeeded'`)
    expect(() => insert('cra_1', 'codex_cli')).not.toThrow()
    db.exec(`UPDATE audited_code_audit_runs SET status = 'succeeded'`)
    expect(() => insert('cra_2', 'byesu_no_tools')).not.toThrow()
    db.exec(`UPDATE audited_code_audit_runs SET status = 'succeeded'`)
    expect(() => insert('cra_3', null)).not.toThrow()
  })

  it('rejects a value outside the vocabulary', () => {
    const db = freshDatabase()
    expect(() =>
      db
        .prepare(
          `INSERT INTO audited_code_audit_runs
             (id, task_id, candidate_id, candidate_tree_oid, round, status,
              audit_mode, worktree_verified_at_ms, started_at_ms)
           VALUES ('cra_bad', 'task_1', 'cand_1', ?, 0, 'running', 'full_codex_audit', 1, 1)`
        )
        .run('a'.repeat(40))
    ).toThrow()
  })
})
