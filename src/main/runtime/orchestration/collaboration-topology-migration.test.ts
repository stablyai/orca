import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { SCHEMA_VERSION } from './db/contract-constants'

describe('durable collaboration topology migration (v42)', () => {
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

  it('adds durable Run topology storage when reopening a v41 database', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-collaboration-topology-migration-'))
    const dbPath = join(tempDir, 'orchestration.db')
    const fresh = new OrchestrationDb(dbPath)
    fresh.close()

    const oldDb = new Database(dbPath)
    oldDb.exec('DROP TABLE run_collaboration_topologies')
    oldDb.exec('DROP TRIGGER trg_runs_forget_collaboration_topology')
    oldDb.pragma('user_version = 41')
    oldDb.close()

    db = new OrchestrationDb(dbPath)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the migration test inspects the OrchestrationDb-owned SQLite connection only to verify user_version and schema presence.
    const sqlite = (db as unknown as { db: Database.Database }).db

    expect(sqlite.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_collaboration_topologies'"
        )
        .get()
    ).toEqual({ name: 'run_collaboration_topologies' })
    const run = db.createRun({
      objective: 'post-v42 migration',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    expect(db.getRunCollaborationTopology(run.id)).toBeUndefined()
  })
})
