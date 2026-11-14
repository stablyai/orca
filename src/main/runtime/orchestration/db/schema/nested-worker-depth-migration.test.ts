import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../../../sqlite/sync-database'
import { dropDerivedDeliverySchema } from './derived-delivery-test-fixture'
import { OrchestrationDb } from '../orchestration-db'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'
import { DROP_REMOVED_WORK_TRIGGERS_SQL } from '../reset/removed-orchestration-work-store'

/** Backfill old workers to depth 1; depth 0 would grant an extra generation of nested workers on upgrade. */
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
    dropDerivedDeliverySchema(oldDb)
    oldDb.exec(DROP_REMOVED_WORK_TRIGGERS_SQL)
    oldDb.exec('ALTER TABLE dispatch_contexts DROP COLUMN depth')
    oldDb.exec('ALTER TABLE remote_dispatch_attachments DROP COLUMN depth')
    oldDb.exec('ALTER TABLE remote_dispatch_attachments DROP COLUMN home_run_id')
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

  it('leaves an upgraded in-flight worker unable to spawn at a cap of 1', () => {
    const dbPath = createV29Database()
    db = new OrchestrationDb(dbPath)
    const sqlite = (db as unknown as { db: Database.Database }).db
    sqlite
      .prepare(
        "UPDATE dispatch_contexts SET assignee_handle = 'term_upgraded' WHERE id = 'ctx_inflight'"
      )
      .run()

    const task = db.createTask({ runId: 'run_legacy_local', spec: 'post-upgrade nesting attempt' })
    expect(() =>
      db!.createDispatchContext({
        taskId: task.id,
        assigneeHandle: 'term_sub',
        creator: { kind: 'terminal', handle: 'term_upgraded' },
        maxDepth: 1
      })
    ).toThrow(/at most 1 level deep, so this worker can't start another \(depth 2\)/)
  })
})
