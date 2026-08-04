// Phase 8 v7 -> v8 migration.
//
// FULLY ADDITIVE, unlike v7: Phase 8 introduces no task state (every state it
// writes has been declared since Phase 1), so audited_tasks' state CHECK is
// unchanged and no table rebuild is needed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SCHEMA_VERSION,
  createAuditedWorkflowTables,
  migrateAuditedWorkflowSchema
} from './audited-task-schema'
import Database from '../sqlite/sync-database'

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name) !== undefined
  )
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name)
}

describe('phase 8 schema', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('creates every Phase 8 table on a fresh database', () => {
    createAuditedWorkflowTables(db)
    expect(tableExists(db, 'audited_approvals')).toBe(true)
    expect(tableExists(db, 'audited_commit_attempts')).toBe(true)
    expect(tableExists(db, 'audited_store_reservations')).toBe(true)
    expect(columnNames(db, 'audited_tasks')).toEqual(
      expect.arrayContaining(['current_approval_id', 'commit_attempt_status'])
    )
    expect(columnNames(db, 'audited_candidates')).toEqual(
      expect.arrayContaining(['store_bytes', 'store_expires_at_ms'])
    )
  })

  it('migrates a v7 database additively and bumps user_version', () => {
    createAuditedWorkflowTables(db)
    // Simulate a v7 database: drop the Phase 8 tables and rewind the version.
    db.exec('DROP TABLE audited_approvals')
    db.exec('DROP TABLE audited_commit_attempts')
    db.exec('DROP TABLE audited_store_reservations')
    db.exec('PRAGMA user_version = 7')

    migrateAuditedWorkflowSchema(db)

    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(tableExists(db, 'audited_approvals')).toBe(true)
    expect(tableExists(db, 'audited_commit_attempts')).toBe(true)
    expect(tableExists(db, 'audited_store_reservations')).toBe(true)
  })

  it('is idempotent', () => {
    createAuditedWorkflowTables(db)
    migrateAuditedWorkflowSchema(db)
    migrateAuditedWorkflowSchema(db)
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
  })

  it('enforces one pending approval per task', () => {
    createAuditedWorkflowTables(db)
    const insert = (id: string, state: string): void => {
      db.prepare(
        `INSERT INTO audited_approvals
           (id, task_id, candidate_id, approved_tree_oid, base_commit, branch_name,
            state, ttl_preset, granted_at_ms, expires_at_ms)
         VALUES (?, 'task1', 'cand_1', ?, ?, 'br', ?, 'standard', 1, 2)`
      ).run(id, 'a'.repeat(40), 'b'.repeat(40), state)
    }
    insert('appr_1', 'pending')
    expect(() => insert('appr_2', 'pending')).toThrow()
    // A non-pending row is unconstrained: history is retained.
    expect(() => insert('appr_3', 'revoked')).not.toThrow()
  })

  it('enforces one authorized commit attempt per task', () => {
    createAuditedWorkflowTables(db)
    const insert = (id: string, status: string): void => {
      db.prepare(
        `INSERT INTO audited_commit_attempts
           (id, task_id, approval_id, intended_tree_oid, intended_parent, intended_branch,
            intended_message_sha, status, authorized_at_ms)
         VALUES (?, 'task1', 'appr_1', ?, ?, 'br', ?, ?, 1)`
      ).run(id, 'a'.repeat(40), 'b'.repeat(40), 'c'.repeat(64), status)
    }
    insert('catt_1', 'authorized')
    expect(() => insert('catt_2', 'authorized')).toThrow()
    expect(() => insert('catt_3', 'failed_no_effect')).not.toThrow()
  })

  it('rejects the removed bare `failed` attempt status', () => {
    createAuditedWorkflowTables(db)
    expect(() =>
      db
        .prepare(
          `INSERT INTO audited_commit_attempts
             (id, task_id, approval_id, intended_tree_oid, intended_parent, intended_branch,
              intended_message_sha, status, authorized_at_ms)
           VALUES ('catt_x', 'task1', 'appr_1', ?, ?, 'br', ?, 'failed', 1)`
        )
        .run('a'.repeat(40), 'b'.repeat(40), 'c'.repeat(64))
    ).toThrow()
  })
})
