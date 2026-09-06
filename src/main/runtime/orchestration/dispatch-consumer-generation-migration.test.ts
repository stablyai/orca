import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { SCHEMA_VERSION } from './db/contract-constants'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { resolveOrchestrationMigrationStartVersion } from './orchestration-schema-version-skew'

/** v36 adds the dispatch consumer generation; a v35 database must land on 0 and keep its mail. */
describe('OrchestrationDb v35 to v36 migration', () => {
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

  /** Builds a current database, then strips it back to the v35 shape it would have on disk. */
  function createV35Database(): { path: string; dispatchId: string; deliveryId: string } {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-db-v36-'))
    const dbPath = join(tempDir, 'orchestration.db')
    const seed = new OrchestrationDb(dbPath)
    const run = seed.createRun({
      objective: 'pre-v36 run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    })
    const task = seed.createTask({ spec: 'mail written before v36', runId: run.id })
    const dispatch = createRootDispatch(seed, task.id, 'term_worker')
    seed.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'still unread',
      runId: dispatch.run_id
    })
    const delivery = seed.getOrCreateMailboxDelivery({
      runId: dispatch.run_id,
      mailboxHandle: `dispatch:${dispatch.id}`,
      consumerGeneration: 0
    })
    seed.close()

    const raw = new Database(dbPath)
    raw.exec(`
      ALTER TABLE dispatch_contexts DROP COLUMN consumer_generation;
      ALTER TABLE remote_dispatch_attachments DROP COLUMN consumer_generation;
    `)
    raw.pragma('user_version = 35')
    raw.close()
    return { path: dbPath, dispatchId: dispatch.id, deliveryId: delivery!.delivery.id }
  }

  it('adds the column at 0 without discarding a v35 outstanding Delivery', () => {
    const v35 = createV35Database()
    db = new OrchestrationDb(v35.path)

    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    const dispatch = db.getDispatchContextById(v35.dispatchId)!
    expect(dispatch.consumer_generation).toBe(0)

    const replayed = db.getOrCreateMailboxDelivery({
      runId: dispatch.run_id,
      mailboxHandle: `dispatch:${v35.dispatchId}`,
      consumerGeneration: 0
    })
    expect(replayed?.delivery.id).toBe(v35.deliveryId)
    expect(replayed?.replayed).toBe(true)
    expect(replayed?.messages.map((message) => message.subject)).toEqual(['still unread'])
  })

  it('does not send a v35 stamp back to the pre-Run repair floor', () => {
    const v35 = createV35Database()
    const raw = new Database(v35.path)
    try {
      expect(resolveOrchestrationMigrationStartVersion(raw, 35, SCHEMA_VERSION)).toBe(35)
    } finally {
      raw.close()
    }
  })

  it('repairs a database stamped v36 that never got the columns', () => {
    const v35 = createV35Database()
    const raw = new Database(v35.path)
    raw.pragma('user_version = 36')
    try {
      // Why: the skew repair is the only thing that catches a partially-written v36.
      expect(resolveOrchestrationMigrationStartVersion(raw, 36, SCHEMA_VERSION)).toBe(6)
    } finally {
      raw.close()
    }
  })
})
