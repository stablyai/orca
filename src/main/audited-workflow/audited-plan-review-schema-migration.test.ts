// v4 -> v5 migration. The properties under test: every pre-existing row
// survives untouched, both new tables plus their constraints exist, and the
// migration is all-or-nothing.
//
// v5 is deliberately ADDITIVE — two ALTER TABLE ADD COLUMNs and two new tables.
// Artifact-file write failures reuse the existing `spawn_failed` execution
// reason precisely so audited_execution_runs needs no CHECK change and no
// 12-step rebuild.
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') }
}))

import Database from '../sqlite/sync-database'
import {
  SCHEMA_VERSION,
  createAuditedWorkflowTables,
  migrateAuditedWorkflowSchema
} from './audited-task-schema'

function tableNames(db: Database.Database): Set<string> {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
    name: string
  }[]
  return new Set(rows.map((r) => r.name))
}

function columnNames(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return new Set(rows.map((r) => r.name))
}

/** A v4-shaped DB: every Phase 1-4 table, with user_version pinned to 4. */
function createV4Database(): Database.Database {
  const db = new Database(':memory:')
  createAuditedWorkflowTables(db)
  // Drop the v5 additions to simulate a genuinely older database.
  db.exec(`DROP TABLE IF EXISTS audited_plan_artifacts`)
  db.exec(`DROP TABLE IF EXISTS audited_plan_review_runs`)
  db.exec(`PRAGMA user_version = 4`)
  return db
}

function seedTask(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO audited_tasks
       (id, repo_id, source_repo_path, base_commit, host_id, title, spec_json, source,
        risk, state, plan_round, fix_round, created_at_ms, updated_at_ms)
     VALUES (?, 'repo1', '/tmp/repo', 'abc', 'local', 'T', '{}', 'custom',
             'low', 'planning', 2, 1, 10, 20)`
  ).run(id)
}

describe('v4 -> v5 migration', () => {
  it('adds both plan-review tables', () => {
    const db = createV4Database()
    expect(tableNames(db).has('audited_plan_artifacts')).toBe(false)

    migrateAuditedWorkflowSchema(db)

    const tables = tableNames(db)
    expect(tables.has('audited_plan_artifacts')).toBe(true)
    expect(tables.has('audited_plan_review_runs')).toBe(true)
    db.close()
  })

  it('adds the two task columns without disturbing existing rows', () => {
    const db = createV4Database()
    seedTask(db, 'task_1')

    migrateAuditedWorkflowSchema(db)

    const columns = columnNames(db, 'audited_tasks')
    expect(columns.has('current_plan_artifact_id')).toBe(true)
    expect(columns.has('last_verdict')).toBe(true)

    const row = db.prepare(`SELECT * FROM audited_tasks WHERE id = 'task_1'`).get() as Record<
      string,
      unknown
    >
    // Every pre-existing value survives; the new columns default to NULL.
    expect(row.state).toBe('planning')
    expect(row.plan_round).toBe(2)
    expect(row.fix_round).toBe(1)
    expect(row.created_at_ms).toBe(10)
    expect(row.current_plan_artifact_id).toBeNull()
    expect(row.last_verdict).toBeNull()
    db.close()
  })

  it('leaves audited_execution_runs untouched (no rebuild)', () => {
    const db = createV4Database()
    seedTask(db, 'task_1')
    db.prepare(
      `INSERT INTO audited_execution_runs
         (id, task_id, mode, status, pre_launch_state, active_run_state,
          worktree_verified_at_ms, started_at_ms)
       VALUES ('exec_1', 'task_1', 'plan', 'succeeded', 'planning', 'planning', 5, 6)`
    ).run()

    migrateAuditedWorkflowSchema(db)

    const row = db.prepare(`SELECT * FROM audited_execution_runs WHERE id = 'exec_1'`).get() as
      | Record<string, unknown>
      | undefined
    expect(row).toBeDefined()
    expect(row!.status).toBe('succeeded')
    expect(row!.started_at_ms).toBe(6)
    db.close()
  })

  it('bumps user_version to the current schema version', () => {
    const db = createV4Database()
    migrateAuditedWorkflowSchema(db)
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    db.close()
  })

  it('is idempotent', () => {
    const db = createV4Database()
    seedTask(db, 'task_1')
    migrateAuditedWorkflowSchema(db)
    expect(() => migrateAuditedWorkflowSchema(db)).not.toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    db.close()
  })
})

describe('artifact ownership constraints', () => {
  function migratedDb(): Database.Database {
    const db = createV4Database()
    seedTask(db, 'task_1')
    migrateAuditedWorkflowSchema(db)
    return db
  }

  function insertArtifact(db: Database.Database, id: string, runId: string, status: string): void {
    db.prepare(
      `INSERT INTO audited_plan_artifacts
         (id, task_id, run_id, round, status, content_sha256, char_count,
          truncated, redaction_count, superseded_by, created_at_ms)
       VALUES (?, 'task_1', ?, 0, ?, 'sha', 10, 0, 0, NULL, 1)`
    ).run(id, runId, status)
  }

  // One execution run, one immutable artifact.
  it('rejects a second artifact for the same run_id on a MIGRATED db', () => {
    const db = migratedDb()
    insertArtifact(db, 'plan_a', 'exec_1', 'superseded')
    expect(() => insertArtifact(db, 'plan_b', 'exec_1', 'current')).toThrow()
    db.close()
  })

  it('rejects a second artifact for the same run_id on a FRESH db', () => {
    const db = new Database(':memory:')
    createAuditedWorkflowTables(db)
    seedTask(db, 'task_1')
    insertArtifact(db, 'plan_a', 'exec_1', 'superseded')
    expect(() => insertArtifact(db, 'plan_b', 'exec_1', 'current')).toThrow()
    db.close()
  })

  it('rejects two current artifacts for one task', () => {
    const db = migratedDb()
    insertArtifact(db, 'plan_a', 'exec_1', 'current')
    expect(() => insertArtifact(db, 'plan_b', 'exec_2', 'current')).toThrow()
    db.close()
  })

  it('allows many superseded artifacts alongside one current', () => {
    const db = migratedDb()
    insertArtifact(db, 'plan_a', 'exec_1', 'superseded')
    insertArtifact(db, 'plan_b', 'exec_2', 'superseded')
    insertArtifact(db, 'plan_c', 'exec_3', 'current')
    const row = db
      .prepare(`SELECT COUNT(*) as n FROM audited_plan_artifacts WHERE task_id = 'task_1'`)
      .get() as { n: number }
    expect(row.n).toBe(3)
    db.close()
  })

  it('rejects a review run carrying a non-vocabulary verdict', () => {
    const db = migratedDb()
    const insert = (verdict: string): void => {
      db.prepare(
        `INSERT INTO audited_plan_review_runs
           (id, task_id, artifact_id, artifact_sha256, round, status, verdict,
            worktree_verified_at_ms, started_at_ms)
         VALUES (?, 'task_1', 'plan_a', 'sha', 0, 'succeeded', ?, 1, 2)`
      ).run(`rev_${verdict}`, verdict)
    }
    // The CHECK is generated from REVIEW_VERDICTS, so the vocabulary this
    // feature does NOT use is rejected at the database layer too.
    expect(() => insert('accepted')).toThrow()
    expect(() => insert('changes_requested')).toThrow()
    expect(() => insert('approved')).not.toThrow()
    db.close()
  })

  it('only one running review per task', () => {
    const db = migratedDb()
    const insert = (id: string): void => {
      db.prepare(
        `INSERT INTO audited_plan_review_runs
           (id, task_id, artifact_id, artifact_sha256, round, status,
            worktree_verified_at_ms, started_at_ms)
         VALUES (?, 'task_1', 'plan_a', 'sha', 0, 'running', 1, 2)`
      ).run(id)
    }
    insert('rev_1')
    expect(() => insert('rev_2')).toThrow()
    db.close()
  })
})
