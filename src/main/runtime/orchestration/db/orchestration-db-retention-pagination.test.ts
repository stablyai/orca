import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../../sqlite/sync-database'
import { OrchestrationDb } from './orchestration-db'
import './messages/mailbox-routing-page'
import './dispatch-row-writer'
import './attempt-outcome-projection'

const MUTATION_RECEIPT_MAX_ROWS = 10_000

function sqliteFor(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

function insertMutationReceipts(
  db: OrchestrationDb,
  count: number,
  state: 'pending' | 'completed'
): void {
  sqliteFor(db)
    .prepare(
      `WITH RECURSIVE receipt_numbers(value) AS (
         VALUES (1)
         UNION ALL
         SELECT value + 1 FROM receipt_numbers WHERE value < ?
       )
       INSERT INTO mutation_receipts (
         caller_fingerprint, request_id, method, payload_hash, state
       )
       SELECT 'caller', printf('request_%05d', value), 'orchestration.send',
              printf('hash_%05d', value), ?
       FROM receipt_numbers`
    )
    .run(count, state)
}

describe('OrchestrationDb bounded mutation receipts', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('prunes expired completed receipts but preserves unresolved receipts', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = sqliteFor(db)
    sqlite.exec(`
      INSERT INTO mutation_receipts (
        caller_fingerprint, request_id, method, payload_hash, state, updated_at
      ) VALUES
        ('caller', 'expired', 'orchestration.send', 'hash_expired', 'completed', '2000-01-01 00:00:00'),
        ('caller', 'unresolved', 'orchestration.send', 'hash_unresolved', 'pending', '2000-01-01 00:00:00');
    `)

    db.beginMutationReceipt({
      callerFingerprint: 'caller',
      requestId: 'new',
      method: 'orchestration.send',
      payloadHash: 'hash_new'
    })

    expect(db.getMutationReceipt('caller', 'expired')).toBeUndefined()
    expect(db.getMutationReceipt('caller', 'unresolved')).toMatchObject({ state: 'pending' })
  })

  it('prunes completed receipts before accepting a remote attachment', () => {
    db = new OrchestrationDb(':memory:')
    insertMutationReceipts(db, MUTATION_RECEIPT_MAX_ROWS, 'completed')

    db.createRemoteDispatchAttachment({
      runId: 'run-home',
      dispatchId: 'ctx_remote_pruned',
      taskId: 'task_remote_pruned',
      homePeerFingerprint: 'caller',
      protocolVersion: 1,
      runtimeEpoch: 'worker_epoch',
      mutationReceipt: {
        callerFingerprint: 'caller',
        requestId: 'remote_pruned',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'hash_remote_pruned'
      }
    })

    const count = sqliteFor(db)
      .prepare('SELECT COUNT(*) AS count FROM mutation_receipts')
      .get() as { count: number }
    expect(count.count).toBeLessThanOrEqual(MUTATION_RECEIPT_MAX_ROWS)
    expect(db.getMutationReceipt('caller', 'request_00001')).toBeUndefined()
    expect(db.getMutationReceipt('caller', 'remote_pruned')).toMatchObject({ state: 'pending' })
    expect(db.getRemoteDispatchAttachment('ctx_remote_pruned')).toBeDefined()
  })

  it('rejects a remote attachment when pending receipts fill the ledger', () => {
    db = new OrchestrationDb(':memory:')
    insertMutationReceipts(db, MUTATION_RECEIPT_MAX_ROWS, 'pending')

    expect(() =>
      db!.createRemoteDispatchAttachment({
        runId: 'run-home',
        dispatchId: 'ctx_remote_overflow',
        taskId: 'task_remote_overflow',
        homePeerFingerprint: 'caller',
        protocolVersion: 1,
        runtimeEpoch: 'worker_epoch',
        mutationReceipt: {
          callerFingerprint: 'caller',
          requestId: 'remote_overflow',
          method: 'orchestration.federationAttachStart',
          payloadHash: 'hash_remote_overflow'
        }
      })
    ).toThrowError(expect.objectContaining({ code: 'mutation_ledger_full' }))
    expect(db.getMutationReceipt('caller', 'request_00001')).toMatchObject({ state: 'pending' })
    expect(db.getMutationReceipt('caller', 'remote_overflow')).toBeUndefined()
    expect(db.getRemoteDispatchAttachment('ctx_remote_overflow')).toBeUndefined()
  })

  it('guards atomic worker acceptance without changing task state', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'capacity check' })
    insertMutationReceipts(db, MUTATION_RECEIPT_MAX_ROWS, 'pending')

    expect(() =>
      db!.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: {},
        mutationReceipt: {
          callerFingerprint: 'caller',
          requestId: 'worker_overflow',
          method: 'orchestration.workerStart',
          payloadHash: 'hash_worker_overflow'
        }
      })
    ).toThrowError(expect.objectContaining({ code: 'mutation_ledger_full' }))
    expect(db.getTask(task.id)).toMatchObject({ status: 'ready' })
    expect(db.getMutationReceipt('caller', 'worker_overflow')).toBeUndefined()
  })
})

describe('OrchestrationDb Run pagination', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('returns stable bounded pages without skipping Runs sharing a timestamp', () => {
    db = new OrchestrationDb(':memory:')
    const createdIds = Array.from({ length: 5 }, (_, index) => `run_page_${index}`)
    const insertRun = sqliteFor(db).prepare(
      `INSERT INTO runs (
         id, objective, coordinator_handle, coordinator_pane_key,
         consumer_generation, legacy, created_at
       ) VALUES (?, ?, ?, ?, 1, 0, '2025-01-01 00:00:00')`
    )
    for (const [index, id] of createdIds.entries()) {
      insertRun.run(
        id,
        `Run ${index}`,
        `term_coord_${index}`,
        `tab_coord_${index}:11111111-1111-4111-8111-111111111111`
      )
    }
    const seen: string[] = []
    let cursor: string | undefined

    do {
      const page = db.listRuns({ limit: 2, cursor })
      expect(page.runs.length).toBeLessThanOrEqual(2)
      expect(page.runs.every((run) => !seen.includes(run.id))).toBe(true)
      seen.push(...page.runs.map((run) => run.id))
      cursor = page.nextCursor ?? undefined
    } while (cursor)

    expect(seen).toEqual(expect.arrayContaining(createdIds))
    expect(new Set(seen).size).toBe(createdIds.length + 1)
  })
})
