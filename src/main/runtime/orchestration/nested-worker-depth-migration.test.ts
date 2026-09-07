import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { resolveOrchestrationMigrationStartVersion } from './orchestration-schema-version-skew'
import { SCHEMA_VERSION } from './db/contract-constants'

/**
 * Backfilling to 1 rather than 0 is the whole point: every pre-v30 row belongs to
 * a worker that was already dispatched, so reading it as a root coordinator would
 * hand every in-flight worker a free generation of sub-workers at upgrade.
 */
describe('nested worker depth migration (v30)', () => {
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

  function createV29Database(): string {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-nested-depth-migration-'))
    const dbPath = join(tempDir, 'orchestration.db')
    const fresh = new OrchestrationDb(dbPath)
    fresh.close()

    const oldDb = new Database(dbPath)
    oldDb.exec('ALTER TABLE dispatch_contexts DROP COLUMN depth')
    oldDb.exec('ALTER TABLE remote_dispatch_attachments DROP COLUMN depth')
    oldDb.pragma('user_version = 29')
    oldDb
      .prepare(
        `INSERT INTO dispatch_contexts (id, run_id, task_id, contract_version, status)
         VALUES ('ctx_inflight', 'run_legacy', 'task_legacy', 1, 'dispatched')`
      )
      .run()
    oldDb
      .prepare(
        `INSERT INTO remote_dispatch_attachments
           (dispatch_id, task_id, home_peer_fingerprint, protocol_version, runtime_epoch, state)
         VALUES ('ctx_remote', 'task_remote', 'peer', 1, 'epoch', 'ready')`
      )
      .run()
    oldDb.close()
    return dbPath
  }

  it('backfills in-flight rows to depth 1, not 0', () => {
    const dbPath = createV29Database()
    db = new OrchestrationDb(dbPath)
    const sqlite = (db as unknown as { db: Database.Database }).db

    expect(sqlite.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(
      sqlite.prepare("SELECT depth FROM dispatch_contexts WHERE id = 'ctx_inflight'").get()
    ).toEqual({ depth: 1 })
    expect(
      sqlite
        .prepare("SELECT depth FROM remote_dispatch_attachments WHERE dispatch_id = 'ctx_remote'")
        .get()
    ).toEqual({ depth: 1 })
  })

  it('leaves an upgraded in-flight worker unable to spawn at the default cap', () => {
    const dbPath = createV29Database()
    db = new OrchestrationDb(dbPath)
    const sqlite = (db as unknown as { db: Database.Database }).db
    sqlite
      .prepare(
        "UPDATE dispatch_contexts SET assignee_handle = 'term_upgraded' WHERE id = 'ctx_inflight'"
      )
      .run()

    const task = db.createTask({ spec: 'post-upgrade nesting attempt' })
    expect(() =>
      db!.createDispatchContext({
        taskId: task.id,
        assigneeHandle: 'term_sub',
        creator: { kind: 'terminal', handle: 'term_upgraded' },
        maxDepth: 1
      })
    ).toThrow(/depth 2 \(max 1\)/)
  })

  it('does not mistake a real v29 database for a broken v30 one', () => {
    // An unconditional column check here would report the schema incomplete and
    // replay migrations from v6 instead of starting at 29.
    const dbPath = createV29Database()
    const oldDb = new Database(dbPath)
    expect(resolveOrchestrationMigrationStartVersion(oldDb, 29, SCHEMA_VERSION)).toBe(29)
    oldDb.close()
  })

  it('widens the attachment pane indexes to the potentially-live states', () => {
    const dbPath = createV29Database()
    db = new OrchestrationDb(dbPath)
    const sqlite = (db as unknown as { db: Database.Database }).db
    const sql = sqlite
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_remote_dispatch_attachments_active_pane'"
      )
      .get() as { sql: string }
    for (const state of ['start_unknown', 'stopping', 'stop_unknown']) {
      expect(sql.sql).toContain(state)
    }
  })
})
