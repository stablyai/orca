import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { SCHEMA_VERSION } from './db/contract-constants'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { resolveOrchestrationMigrationStartVersion } from './orchestration-schema-version-skew'

const CREATOR_COLUMNS = ['creator_handle', 'creator_pane_key'] as const
const WORKER_PANE = 'tab_worker:dddddddd-dddd-4ddd-8ddd-dddddddddddd'

/** v37 records who created a Dispatch; a v36 row has no creator and must keep counting as a parent. */
describe('OrchestrationDb v36 to v37 migration', () => {
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

  /** Builds a current database, then strips it back to the v36 shape it would have on disk. */
  function createV36Database(): { path: string; dispatchId: string } {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-db-v37-'))
    const dbPath = join(tempDir, 'orchestration.db')
    const seed = new OrchestrationDb(dbPath)
    const run = seed.createRun({
      objective: 'pre-v37 run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    })
    const task = seed.createTask({ spec: 'dispatched before v37', runId: run.id })
    const dispatch = createRootDispatch(seed, task.id, 'term_worker', WORKER_PANE)
    seed.close()

    const raw = new Database(dbPath)
    for (const column of CREATOR_COLUMNS) {
      raw.exec(`ALTER TABLE dispatch_contexts DROP COLUMN ${column}`)
    }
    raw.pragma('user_version = 36')
    raw.close()
    return { path: dbPath, dispatchId: dispatch.id }
  }

  it('adds the columns as null and keeps the unattributed row a nesting parent', () => {
    const v36 = createV36Database()
    db = new OrchestrationDb(v36.path)

    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(db.getDispatchContextById(v36.dispatchId)).toMatchObject({
      creator_handle: null,
      creator_pane_key: null
    })
    expect(
      db.resolveCreatorDepth({ kind: 'terminal', handle: 'term_worker', paneKey: WORKER_PANE })
    ).toBe(1)
  })

  it('repairs a database stamped v37 that never got the columns', () => {
    const v36 = createV36Database()
    const raw = new Database(v36.path)
    raw.pragma('user_version = 37')
    try {
      // Why: the skew repair is the only thing that catches a partially-written v37.
      expect(resolveOrchestrationMigrationStartVersion(raw, 37, SCHEMA_VERSION)).toBe(6)
    } finally {
      raw.close()
    }
  })
})
