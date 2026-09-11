import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from '../../../../sqlite/sync-database'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { SCHEMA_VERSION } from '../contract-constants'
import { migrateV41 } from './migrate-v41'

const LEAF1 = '11111111-1111-4111-8111-111111111111'
const LEAF2 = '22222222-2222-4222-8222-222222222222'
const LEAF3 = '33333333-3333-4333-8333-333333333333'
const STRUCTURED_PANE = `structured-agent-session-sess1:${LEAF2}`

/** Puts an already-migrated database back into v40 shape for the direct-unit cases. */
function revertToV40Shape(db: OrchestrationDb): void {
  db.db.exec(`
    DROP TRIGGER IF EXISTS trg_runs_remember_coordinator_insert;
    DROP TRIGGER IF EXISTS trg_runs_remember_coordinator_update;
    DROP INDEX IF EXISTS idx_runs_coordinator_principal;
    ALTER TABLE runs DROP COLUMN coordinator_principal;
    ALTER TABLE dispatch_contexts DROP COLUMN assignee_principal;
    ALTER TABLE dispatch_contexts DROP COLUMN creator_principal;
    ALTER TABLE worker_terminal_resources DROP COLUMN principal;
  `)
}

function seedV40Rows(db: OrchestrationDb): void {
  db.db.exec(`
    INSERT INTO runs (id, objective, coordinator_handle, coordinator_pane_key, legacy)
      VALUES ('run_paned', 'paned', 'term_a', 'tab_a:${LEAF1}', 0);
    INSERT INTO runs (id, objective, coordinator_handle, coordinator_pane_key, legacy)
      VALUES ('run_structured', 'structured', 'structworker_x', '${STRUCTURED_PANE}', 0);
    INSERT INTO runs (id, objective, legacy) VALUES ('run_unbound', 'unbound', 0);
    INSERT INTO dispatch_contexts (id, task_id, assignee_pane_key, creator_pane_key, status)
      VALUES ('ctx_paned', 't1', 'tab_b:${LEAF1}', 'tab_c:${LEAF3}', 'dispatched');
    INSERT INTO dispatch_contexts (id, task_id, status) VALUES ('ctx_null', 't2', 'pending');
    INSERT INTO worker_terminal_resources (id, origin_dispatch_id, owner_dispatch_id, terminal_handle, pane_key)
      VALUES ('wtr_paned', 'ctx_paned', 'ctx_paned', 'term_w', 'tab_d:${LEAF3}');
    INSERT INTO worker_terminal_resources (id, origin_dispatch_id, owner_dispatch_id, terminal_handle)
      VALUES ('wtr_null', 'ctx_null', 'ctx_null', 'term_x');
  `)
}

function principalSnapshot(db: OrchestrationDb): unknown[] {
  return [
    ...db.db.prepare('SELECT id, coordinator_principal FROM runs ORDER BY id').all(),
    ...db.db
      .prepare(
        'SELECT id, assignee_principal, creator_principal FROM dispatch_contexts ORDER BY id'
      )
      .all(),
    ...db.db.prepare('SELECT id, principal FROM worker_terminal_resources ORDER BY id').all()
  ]
}

describe('principal column migration', () => {
  const tempRoots: string[] = []

  afterEach(() => {
    while (tempRoots.length > 0) {
      rmSync(tempRoots.pop() as string, { recursive: true, force: true })
    }
  })

  function tempDbPath(): string {
    const root = mkdtempSync(join(tmpdir(), 'orca-principal-migration-'))
    tempRoots.push(root)
    return join(root, 'orchestration.db')
  }

  it('v40 -> v41 migrates and backfills by classification, and is idempotent', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      revertToV40Shape(db)
      seedV40Rows(db)
      migrateV41.call(db, 40)

      expect(principalSnapshot(db)).toEqual([
        { id: 'run_legacy_local', coordinator_principal: null },
        { id: 'run_paned', coordinator_principal: `pane:tab_a:${LEAF1}` },
        { id: 'run_structured', coordinator_principal: 'session:sess1' },
        { id: 'run_unbound', coordinator_principal: null },
        { id: 'ctx_null', assignee_principal: null, creator_principal: null },
        {
          id: 'ctx_paned',
          assignee_principal: `pane:tab_b:${LEAF1}`,
          creator_principal: `pane:tab_c:${LEAF3}`
        },
        { id: 'wtr_null', principal: null },
        { id: 'wtr_paned', principal: `pane:tab_d:${LEAF3}` }
      ])
      // Non-identity columns untouched.
      expect(
        db.db.prepare('SELECT objective, legacy FROM runs WHERE id = ?').get('run_paned')
      ).toEqual({ objective: 'paned', legacy: 0 })

      const before = principalSnapshot(db)
      migrateV41.call(db, 40)
      expect(principalSnapshot(db)).toEqual(before)
    } finally {
      db.close()
    }
  })

  it('runs the real chain from a seeded v40 file database, cache and triggers included', () => {
    const path = tempDbPath()
    const seed = new Database(path)
    // v40 shapes for exactly the tables v41 touches; createTables supplies every other table, and
    // a 40 stamp survives the completeness probe so the migration start resolves to 40.
    seed.exec(`
      CREATE TABLE runs (
        id                    TEXT PRIMARY KEY,
        objective             TEXT NOT NULL,
        home_database         TEXT NOT NULL DEFAULT 'this_database',
        coordinator_handle    TEXT,
        coordinator_pane_key  TEXT,
        consumer_generation   INTEGER NOT NULL DEFAULT 0,
        legacy                INTEGER NOT NULL DEFAULT 0,
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE run_coordinator_handles (
        run_id          TEXT NOT NULL,
        terminal_handle TEXT NOT NULL,
        first_bound_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (run_id, terminal_handle)
      );
      CREATE TRIGGER trg_runs_remember_coordinator_insert
      AFTER INSERT ON runs
      WHEN NEW.legacy = 0 AND NEW.coordinator_handle IS NOT NULL
      BEGIN
        INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
        VALUES (NEW.id, NEW.coordinator_handle);
      END;
      CREATE TRIGGER trg_runs_remember_coordinator_update
      AFTER UPDATE OF coordinator_handle ON runs
      WHEN NEW.legacy = 0 AND NEW.coordinator_handle IS NOT NULL
      BEGIN
        INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
        VALUES (NEW.id, NEW.coordinator_handle);
      END;
      INSERT INTO runs (id, objective, coordinator_handle, coordinator_pane_key, legacy)
        VALUES ('run_paned', 'paned', 'term_a', 'tab_a:${LEAF1}', 0);
      INSERT INTO runs (id, objective, coordinator_handle, coordinator_pane_key, legacy)
        VALUES ('run_structured', 'structured', 'structworker_x', '${STRUCTURED_PANE}', 0);
      INSERT INTO run_coordinator_handles (run_id, terminal_handle) VALUES ('run_paned', 'term_old');
    `)
    seed.pragma('user_version = 40')
    seed.close()

    const db = new OrchestrationDb(path)
    try {
      expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
      expect(
        db.db.prepare('SELECT coordinator_principal FROM runs WHERE id = ?').get('run_paned')
      ).toEqual({ coordinator_principal: `pane:tab_a:${LEAF1}` })
      expect(
        db.db.prepare('SELECT coordinator_principal FROM runs WHERE id = ?').get('run_structured')
      ).toEqual({ coordinator_principal: 'session:sess1' })
      // Cache shape unchanged: handle-bearing coordinators stay handle-keyed, history included.
      expect(
        db.db
          .prepare(
            'SELECT run_id, terminal_handle FROM run_coordinator_handles ORDER BY run_id, terminal_handle'
          )
          .all()
      ).toEqual([
        { run_id: 'run_paned', terminal_handle: 'term_a' },
        { run_id: 'run_paned', terminal_handle: 'term_old' },
        { run_id: 'run_structured', terminal_handle: 'structworker_x' }
      ])
      // The DROP/recreate replaced the old-predicate triggers; CREATE TRIGGER IF NOT EXISTS alone
      // would have kept the handle-only form on this upgraded database.
      const triggerSql = db.db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN " +
            "('trg_runs_remember_coordinator_insert', 'trg_runs_remember_coordinator_update')"
        )
        .all() as { name: string; sql: string }[]
      expect(triggerSql).toHaveLength(2)
      for (const trigger of triggerSql) {
        expect(trigger.sql).toContain('coordinator_principal')
      }
    } finally {
      db.close()
    }
  })

  it('repairs rows a rolled-back binary wrote after user_version reached 41', () => {
    const path = tempDbPath()
    const first = new OrchestrationDb(path)
    // A pre-v41 binary's insert shape: explicit columns, no principals.
    first.db.exec(`
      INSERT INTO dispatch_contexts (id, task_id, assignee_pane_key, creator_pane_key, status)
        VALUES ('ctx_rolled_back', 't1', 'tab_b:${LEAF1}', 'tab_c:${LEAF3}', 'dispatched');
      INSERT INTO dispatch_contexts (id, task_id, assignee_pane_key, assignee_principal, status)
        VALUES ('ctx_stale', 't2', 'tab_b:${LEAF1}', 'pane:tab_b:${LEAF1}', 'dispatched');
    `)
    // A pre-v41 binary re-points the pane without touching the principal, leaving it stale.
    first.db
      .prepare('UPDATE dispatch_contexts SET assignee_pane_key = ? WHERE id = ?')
      .run(`tab_z:${LEAF2}`, 'ctx_stale')
    first.close()

    const reopened = new OrchestrationDb(path)
    try {
      expect(
        reopened.db
          .prepare(
            'SELECT assignee_principal, creator_principal FROM dispatch_contexts WHERE id = ?'
          )
          .get('ctx_rolled_back')
      ).toEqual({
        assignee_principal: `pane:tab_b:${LEAF1}`,
        creator_principal: `pane:tab_c:${LEAF3}`
      })
      expect(
        reopened.db
          .prepare('SELECT assignee_principal FROM dispatch_contexts WHERE id = ?')
          .get('ctx_stale')
      ).toEqual({ assignee_principal: `pane:tab_z:${LEAF2}` })
    } finally {
      reopened.close()
    }
  })

  it('never touches a session principal on reopen, even when its pane columns disagree', () => {
    const path = tempDbPath()
    const first = new OrchestrationDb(path)
    // A session row's pane columns hold the minted fake key by design; the reconcile must not
    // re-assert a pane: value over it on every open.
    first.db.exec(`
      INSERT INTO dispatch_contexts (id, task_id, assignee_pane_key, assignee_principal, status)
        VALUES ('ctx_session', 't1', 'tab_b:${LEAF1}', 'session:s1', 'dispatched');
    `)
    first.close()

    const reopened = new OrchestrationDb(path)
    try {
      expect(
        reopened.db
          .prepare('SELECT assignee_principal FROM dispatch_contexts WHERE id = ?')
          .get('ctx_session')
      ).toEqual({ assignee_principal: 'session:s1' })
    } finally {
      reopened.close()
    }
  })

  it('caches a handle-less session coordinator row for the seam later PRs read', () => {
    const path = tempDbPath()
    const db = new OrchestrationDb(path)
    // Raw SQL is honest here: no PR1 production writer can produce such a row; this pins the seam
    // PR3 (read side) and PR5 (session-row producer) build on.
    db.db.exec(`
      INSERT INTO runs (id, objective, coordinator_principal, legacy)
        VALUES ('run_session', 'session coordinator', 'session:s1', 0);
    `)
    expect(
      db.db
        .prepare('SELECT terminal_handle FROM run_coordinator_handles WHERE run_id = ?')
        .all('run_session')
    ).toEqual([{ terminal_handle: 'session:s1' }])
    // COALESCE puts the principal in the mailbox-address column, so the existing reroute trigger
    // matches it by plain string equality with zero read-side change.
    db.db.exec(`
      INSERT INTO messages (id, run_id, from_handle, to_handle, subject)
        VALUES ('msg_1', 'run_session', 'term_worker', 'session:s1', 'reply');
    `)
    expect(db.db.prepare('SELECT to_handle FROM messages WHERE id = ?').get('msg_1')).toEqual({
      to_handle: 'run:run_session'
    })
    db.close()

    // Reopen: repopulate adds no duplicate (PK + INSERT OR IGNORE).
    const reopened = new OrchestrationDb(path)
    try {
      expect(
        reopened.db
          .prepare('SELECT COUNT(*) AS rows FROM run_coordinator_handles WHERE run_id = ?')
          .get('run_session')
      ).toEqual({ rows: 1 })
      // Zero-behavior-change guard: createRun/bindRun still produce exactly the handle-keyed rows
      // they produce on main.
      const run = reopened.createRun({
        objective: 'guard',
        coordinatorHandle: 'term_guard',
        coordinatorPaneKey: `tab_guard:${LEAF1}`
      })
      expect(
        reopened.db
          .prepare('SELECT terminal_handle FROM run_coordinator_handles WHERE run_id = ?')
          .all(run.id)
      ).toEqual([{ terminal_handle: 'term_guard' }])
      reopened.bindRun({
        runId: run.id,
        coordinatorHandle: 'term_rebound',
        coordinatorPaneKey: `tab_rebound:${LEAF2}`
      })
      expect(
        reopened.db
          .prepare(
            'SELECT terminal_handle FROM run_coordinator_handles WHERE run_id = ? ORDER BY terminal_handle'
          )
          .all(run.id)
      ).toEqual([{ terminal_handle: 'term_guard' }, { terminal_handle: 'term_rebound' }])
    } finally {
      reopened.close()
    }
  })
})
