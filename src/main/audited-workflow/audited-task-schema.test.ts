// Proves the v1 -> v2 migration (Phase 2: triage columns + audited_triage_runs
// table) is purely additive and preserves pre-existing task/transition data.
// Builds a v1-shaped database by hand (the exact DDL Phase 1 shipped, before
// the triage columns/table existed) rather than importing v1 code, since no
// v1 module snapshot exists to import from — this is the standard way to
// pin a historical on-disk shape for a migration test.
import Database from '../sqlite/sync-database'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateAuditedWorkflowSchema, createAuditedWorkflowTables } from './audited-task-schema'
import { AuditedTaskRepository } from './audited-task-repository'

function createV1Database(db: Database.Database): void {
  db.exec(`
    CREATE TABLE audited_tasks (
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
      source                      TEXT NOT NULL,
      roadmap_entry_id            TEXT,
      risk                        TEXT NOT NULL,
      state                       TEXT NOT NULL,
      pre_block_state             TEXT,
      blocked_reason_code         TEXT,
      blocked_phase                TEXT,
      active_phase                TEXT,
      active_lock_binding         TEXT,
      plan_round                  INTEGER NOT NULL DEFAULT 0,
      fix_round                   INTEGER NOT NULL DEFAULT 0,
      audit_approved_tree_oid     TEXT,
      committed_sha               TEXT,
      landed_sha                  TEXT,
      landed_base_sha             TEXT,
      landing_reason_code         TEXT,
      created_at_ms                INTEGER NOT NULL,
      updated_at_ms                INTEGER NOT NULL
    );
    CREATE INDEX idx_audited_tasks_repo  ON audited_tasks(repo_id);
    CREATE INDEX idx_audited_tasks_state ON audited_tasks(state);

    CREATE TABLE audited_transitions (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     TEXT NOT NULL,
      from_state  TEXT,
      to_state    TEXT NOT NULL,
      actor       TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      reason_code TEXT,
      detail_json TEXT,
      at_ms       INTEGER NOT NULL
    );
    CREATE INDEX idx_audited_transitions_task ON audited_transitions(task_id, seq);
  `)
  db.exec(`PRAGMA user_version = 1`)
}

describe('audited-task-schema v1 -> v2 migration', () => {
  let db: Database.Database | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('is purely additive: no v1 table or column is dropped or renamed', () => {
    db = new Database(':memory:')
    createV1Database(db)

    migrateAuditedWorkflowSchema(db)
    // migrateAuditedWorkflowSchema alone does not run createAuditedWorkflowTables
    // (that's the repository constructor's job, in that order) — call it here
    // to mirror AuditedTaskRepository's real startup sequence.
    createAuditedWorkflowTables(db)

    const columns = (
      db.prepare(`PRAGMA table_info(audited_tasks)`).all() as { name: string }[]
    ).map((c) => c.name)
    // Every original v1 column is still present.
    for (const v1Column of [
      'id',
      'repo_id',
      'source_repo_path',
      'base_commit',
      'title',
      'spec_json',
      'source',
      'risk',
      'state',
      'plan_round',
      'fix_round',
      'created_at_ms',
      'updated_at_ms'
    ]) {
      expect(columns).toContain(v1Column)
    }
    // The three new v2 columns were added.
    expect(columns).toContain('triage_decision')
    expect(columns).toContain('triage_run_status')
    expect(columns).toContain('triage_blocked_reason_code')

    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
    ).map((t) => t.name)
    expect(tables).toContain('audited_tasks')
    expect(tables).toContain('audited_transitions')
    expect(tables).toContain('audited_triage_runs')
  })

  it('preserves existing task and transition data exactly across the migration', () => {
    db = new Database(':memory:')
    createV1Database(db)
    db.prepare(
      `INSERT INTO audited_tasks (id, repo_id, source_repo_path, base_commit, title, spec_json, source, risk, state, plan_round, fix_round, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'audited_preexisting',
      'repo1',
      '/repos/repo1',
      'a'.repeat(40),
      'Pre-existing task',
      JSON.stringify({ title: 'Pre-existing task', description: 'From before Phase 2' }),
      'custom',
      'medium',
      'blocked',
      0,
      0,
      1000,
      2000
    )
    db.prepare(
      `INSERT INTO audited_transitions (task_id, from_state, to_state, actor, event_type, reason_code, detail_json, at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('audited_preexisting', null, 'selected', 'human', 'task_created', null, null, 1000)

    migrateAuditedWorkflowSchema(db)
    createAuditedWorkflowTables(db)

    const row = db
      .prepare(`SELECT * FROM audited_tasks WHERE id = ?`)
      .get('audited_preexisting') as Record<string, unknown>
    expect(row.title).toBe('Pre-existing task')
    expect(row.state).toBe('blocked')
    expect(row.created_at_ms).toBe(1000)
    expect(row.updated_at_ms).toBe(2000)
    // New columns exist and default to NULL for pre-existing rows — no
    // fabricated triage history is invented for tasks that predate triage.
    expect(row.triage_decision).toBeNull()
    expect(row.triage_run_status).toBeNull()
    expect(row.triage_blocked_reason_code).toBeNull()

    const transitions = db
      .prepare(`SELECT * FROM audited_transitions WHERE task_id = ?`)
      .all('audited_preexisting') as Record<string, unknown>[]
    expect(transitions).toHaveLength(1)
    expect(transitions[0].event_type).toBe('task_created')
  })

  it('bumps user_version to 2 and is idempotent (safe to run again)', () => {
    db = new Database(':memory:')
    createV1Database(db)

    migrateAuditedWorkflowSchema(db)
    expect(db.pragma('user_version', { simple: true })).toBe(2)

    // Running again must not throw or duplicate columns/tables.
    expect(() => migrateAuditedWorkflowSchema(db!)).not.toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(2)
  })

  it('a v1 on-disk database opened via the real repository constructor migrates and remains fully usable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audited-workflow-migration-'))
    try {
      const dbPath = join(dir, 'audited-workflow.db')

      const v1Db = new Database(dbPath)
      createV1Database(v1Db)
      v1Db
        .prepare(
          `INSERT INTO audited_tasks (id, repo_id, source_repo_path, base_commit, title, spec_json, source, risk, state, plan_round, fix_round, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'audited_old',
          'repo1',
          '/repos/repo1',
          'a'.repeat(40),
          'Old task',
          JSON.stringify({ title: 'Old task', description: '' }),
          'custom',
          'low',
          'selected',
          0,
          0,
          500,
          500
        )
      v1Db.close()

      // Opening via the real repository constructor runs the exact production
      // sequence: createAuditedWorkflowTables (creates any missing table) then
      // migrateAuditedWorkflowSchema (adds any missing column, bumps version).
      const repo = new AuditedTaskRepository(dbPath)
      try {
        const preExisting = repo.getTask('audited_old')
        expect(preExisting?.title).toBe('Old task')
        expect(preExisting?.state).toBe('selected')
        expect(preExisting?.triageDecision).toBeNull()

        // The new triage machinery works against the migrated database.
        const started = repo.startTriageRun('audited_old')
        expect(started.ok).toBe(true)
        if (!started.ok) {
          throw new Error('expected ok')
        }
        const finalized = repo.finalizeTriageRunSucceeded({
          runId: started.runId,
          taskId: 'audited_old',
          decision: 'direct',
          reasonCode: null,
          rationale: 'x',
          acceptanceCriteria: [{ id: '1', text: 'x', covered: false }],
          nextStepPrompt: 'x'
        })
        expect(finalized.ok).toBe(true)
        expect(repo.getTask('audited_old')?.state).toBe('ready_to_implement')
      } finally {
        repo.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
