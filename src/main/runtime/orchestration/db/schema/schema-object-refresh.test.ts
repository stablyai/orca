import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'

const OBJECTS_SQL = `SELECT type, name, sql FROM sqlite_master
  WHERE type IN ('trigger', 'view') ORDER BY type, name`

describe('triggers and views on open', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-schema-refresh-'))
    path = join(dir, 'orchestration.db')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function reopen(edit?: (db: OrchestrationDb) => void): OrchestrationDb {
    const first = new OrchestrationDb(path)
    edit?.(first)
    first.close()
    return new OrchestrationDb(path)
  }

  it('leaves an unchanged schema untouched', () => {
    const first = new OrchestrationDb(path)
    const version = first.db.pragma('schema_version', { simple: true })
    first.close()

    const second = new OrchestrationDb(path)
    try {
      expect(second.db.pragma('schema_version', { simple: true })).toBe(version)
    } finally {
      second.close()
    }
  })

  it("restores this build's definitions after an older build replaced them", () => {
    const fresh = new OrchestrationDb(':memory:')
    const expected = fresh.db.prepare(OBJECTS_SQL).all()
    fresh.close()

    const db = reopen((older) =>
      older.db.exec(`
        DROP TRIGGER trg_messages_route_coordinator_mail;
        CREATE TRIGGER trg_messages_route_coordinator_mail AFTER INSERT ON messages BEGIN SELECT 1; END;
        DROP VIEW peer_run_dispatch_state;
        CREATE VIEW peer_run_dispatch_state AS SELECT id AS dispatch_id FROM dispatch_contexts;
        DROP TRIGGER trg_peer_run_correction;
        DROP TRIGGER trg_runs_remember_coordinator_update;
      `)
    )
    try {
      expect(db.db.prepare(OBJECTS_SQL).all()).toEqual(expected)
    } finally {
      db.close()
    }
  })
})
