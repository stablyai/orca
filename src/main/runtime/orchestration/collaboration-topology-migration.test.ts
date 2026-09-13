import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { SCHEMA_VERSION } from './db/contract-constants'

describe('durable collaboration topology migration (v41)', () => {
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

  function expectTopologySchema(sqlite: Database.Database): void {
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_collaboration_topologies'"
        )
        .get()
    ).toEqual({ name: 'run_collaboration_topologies' })
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_runs_forget_collaboration_topology'"
        )
        .get()
    ).toEqual({ name: 'trg_runs_forget_collaboration_topology' })
  }

  it('creates durable Run topology storage in a new database', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-collaboration-topology-new-'))
    db = new OrchestrationDb(join(tempDir, 'orchestration.db'))

    expectTopologySchema((db as unknown as { db: Database.Database }).db)
  })

  it('adds durable Run topology storage when migrating directly from v40', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-collaboration-topology-migration-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    const sqlite = (db as unknown as { db: Database.Database }).db
    sqlite.exec('DROP TABLE run_collaboration_topologies')
    sqlite.exec('DROP TRIGGER trg_runs_forget_collaboration_topology')
    sqlite.pragma('user_version = 40')

    db.migrate()

    expect(sqlite.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expectTopologySchema(sqlite)
  })

  it('adds durable Run topology storage when reopening an older v30 database', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-collaboration-topology-migration-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    const sqlite = (db as unknown as { db: Database.Database }).db
    sqlite.exec('DROP TABLE run_collaboration_topologies')
    sqlite.exec('DROP TRIGGER trg_runs_forget_collaboration_topology')
    sqlite.pragma('user_version = 30')
    db.close()
    db = undefined

    db = new OrchestrationDb(dbPath)
    const migratedSqlite = (db as unknown as { db: Database.Database }).db

    expect(migratedSqlite.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expectTopologySchema(migratedSqlite)
    const run = db.createRun({
      objective: 'post-v30 migration',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    expect(db.getRunCollaborationTopology(run.id)).toBeUndefined()
  })
})
