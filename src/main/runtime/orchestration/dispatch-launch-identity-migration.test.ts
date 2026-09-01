import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { SCHEMA_VERSION } from './db/contract-constants'

/** Rebuilds the shipped v29 shape of `dispatch_contexts`: the launch-identity
 *  columns and the widened status CHECK are absent, everything else is present. */
function downgradeToV29(dbPath: string): void {
  const old = new Database(dbPath)
  old.exec(`
    DROP TRIGGER IF EXISTS trg_messages_route_coordinator_mail;
    DROP TABLE dispatch_contexts;
    CREATE TABLE dispatch_contexts (
      id                    TEXT PRIMARY KEY,
      run_id                TEXT NOT NULL DEFAULT 'legacy',
      task_id               TEXT NOT NULL,
      contract_version      INTEGER NOT NULL DEFAULT 1,
      launch_token_hash     TEXT,
      assignee_handle       TEXT,
      assignee_pane_key     TEXT,
      capability_hash       TEXT,
      process_incarnation   TEXT,
      capability_revoked_at TEXT,
      status                TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'dispatched', 'completed', 'failed', 'circuit_broken')),
      failure_count         INTEGER NOT NULL DEFAULT 0,
      last_failure          TEXT,
      termination_reason    TEXT,
      dispatched_at         TEXT,
      completed_at          TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      last_heartbeat_at     TEXT
    );
  `)
  old.pragma('user_version = 29')
  old.close()
}

function columnNames(sqlite: Database.Database, table: string): string[] {
  return (sqlite.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name)
}

describe('dispatch launch-identity migration', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  function openV29Fixture(): { dbPath: string } {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-dispatch-launch-identity-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    db.close()
    db = undefined
    downgradeToV29(dbPath)
    return { dbPath }
  }

  // The launch-identity work shipped inside an `if (current < 29)` step while
  // SCHEMA_VERSION was still 29, so every already-stamped install applied none
  // of it and the first dispatch threw "no column named requested_agent".
  it('adds the launch-identity columns to a database already stamped v29', () => {
    const { dbPath } = openV29Fixture()

    db = new OrchestrationDb(dbPath)
    const sqlite = (db as unknown as { db: Database.Database }).db

    expect(sqlite.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(columnNames(sqlite, 'dispatch_contexts')).toEqual(
      expect.arrayContaining(['requested_agent', 'base_agent', 'agent_launch_failure'])
    )
  })

  it('widens the status CHECK so a dispatch can be forgotten', () => {
    const { dbPath } = openV29Fixture()

    db = new OrchestrationDb(dbPath)
    const sqlite = (db as unknown as { db: Database.Database }).db
    sqlite
      .prepare(
        `INSERT INTO dispatch_contexts (id, task_id, status) VALUES ('ctx_a', 't', 'pending')`
      )
      .run()

    expect(() =>
      sqlite.prepare(`UPDATE dispatch_contexts SET status = 'forgotten' WHERE id = 'ctx_a'`).run()
    ).not.toThrow()
  })

  // The rebuild dropped and renamed dispatch_contexts while the persisted
  // coordinator-mail trigger referenced it, so SQLite aborted the RENAME and
  // the DB could not be opened again until the file was deleted.
  it('opens when the coordinator-mail trigger references dispatch_contexts', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-dispatch-launch-identity-trigger-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    db.close()
    db = undefined

    downgradeToV29(dbPath)
    const withTrigger = new Database(dbPath)
    withTrigger.exec(`
      CREATE TRIGGER trg_messages_route_coordinator_mail
      AFTER INSERT ON messages
      WHEN NEW.read = 0
        AND NOT EXISTS (
          SELECT 1 FROM dispatch_contexts
          WHERE run_id = NEW.run_id AND assignee_handle = NEW.to_handle
            AND status IN ('pending', 'dispatched')
        )
      BEGIN
        UPDATE messages SET to_handle = 'run:' || NEW.run_id WHERE sequence = NEW.sequence;
      END;
    `)
    withTrigger.close()

    expect(() => {
      db = new OrchestrationDb(dbPath)
    }).not.toThrow()
    const sqlite = (db as unknown as { db: Database.Database }).db
    expect(sqlite.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
  })

  // The rebuild omitted termination_reason from both the new table and the
  // INSERT…SELECT, so the column and every persisted reason were destroyed and
  // failDispatch could never settle a dispatch again.
  it('preserves termination_reason and its data across the rebuild', () => {
    const { dbPath } = openV29Fixture()

    const seed = new Database(dbPath)
    seed
      .prepare(
        `INSERT INTO dispatch_contexts (id, task_id, status, termination_reason)
         VALUES ('ctx_terminated', 'task_1', 'failed', 'process_exited')`
      )
      .run()
    seed.close()

    db = new OrchestrationDb(dbPath)
    const sqlite = (db as unknown as { db: Database.Database }).db

    expect(columnNames(sqlite, 'dispatch_contexts')).toContain('termination_reason')
    expect(
      sqlite
        .prepare(`SELECT termination_reason FROM dispatch_contexts WHERE id = 'ctx_terminated'`)
        .get()
    ).toEqual({ termination_reason: 'process_exited' })
  })
})
