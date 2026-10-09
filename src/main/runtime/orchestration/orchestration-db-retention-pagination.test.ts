import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { SCHEMA_VERSION } from './db/contract-constants'
import { createRootDispatch } from './db/root-dispatch-test-fixture'

const PREVIOUS_RECEIPT_LIMIT = 10_000

function sqliteFor(db: OrchestrationDb): Database.Database {
  return db.db
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

describe('OrchestrationDb mutation receipt admission', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('accepts receipts without pruning unrelated old receipts', () => {
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

    expect(db.getMutationReceipt('caller', 'expired')).toMatchObject({ state: 'completed' })
    expect(db.getMutationReceipt('caller', 'unresolved')).toMatchObject({ state: 'pending' })
  })

  it('retains completed receipts beyond the previous count limit', () => {
    db = new OrchestrationDb(':memory:')
    insertMutationReceipts(db, PREVIOUS_RECEIPT_LIMIT, 'completed')

    db.beginMutationReceipt({
      callerFingerprint: 'caller',
      requestId: 'new',
      method: 'orchestration.send',
      payloadHash: 'hash_new'
    })

    const count = sqliteFor(db).prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get()
    expect(count?.count).toBe(PREVIOUS_RECEIPT_LIMIT + 1)
    expect(db.getMutationReceipt('caller', 'request_00001')).toMatchObject({ state: 'completed' })
    expect(db.getMutationReceipt('caller', 'request_10000')).toMatchObject({ state: 'completed' })
    expect(db.getMutationReceipt('caller', 'new')).toMatchObject({ state: 'pending' })
  })

  it('accepts fresh receipts beyond the previous pending limit', () => {
    db = new OrchestrationDb(':memory:')
    insertMutationReceipts(db, PREVIOUS_RECEIPT_LIMIT + 1, 'pending')

    db.beginMutationReceipt({
      callerFingerprint: 'caller',
      requestId: 'overflow',
      method: 'orchestration.send',
      payloadHash: 'hash_overflow'
    })
    expect(db.getMutationReceipt('caller', 'request_00001')).toMatchObject({ state: 'pending' })
    expect(db.getMutationReceipt('caller', 'overflow')).toMatchObject({ state: 'pending' })
  })

  it('accepts a remote attachment without pruning other receipts', () => {
    db = new OrchestrationDb(':memory:')
    insertMutationReceipts(db, PREVIOUS_RECEIPT_LIMIT, 'completed')

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

    const count = sqliteFor(db).prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get()
    expect(count?.count).toBe(PREVIOUS_RECEIPT_LIMIT + 1)
    expect(db.getMutationReceipt('caller', 'request_00001')).toMatchObject({ state: 'completed' })
    expect(db.getMutationReceipt('caller', 'remote_pruned')).toMatchObject({ state: 'pending' })
    expect(db.getRemoteDispatchAttachment('ctx_remote_pruned')).toBeDefined()
  })

  it('accepts a remote attachment beyond the previous pending limit', () => {
    db = new OrchestrationDb(':memory:')
    insertMutationReceipts(db, PREVIOUS_RECEIPT_LIMIT + 1, 'pending')

    db.createRemoteDispatchAttachment({
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
    expect(db.getMutationReceipt('caller', 'request_00001')).toMatchObject({ state: 'pending' })
    expect(db.getMutationReceipt('caller', 'remote_overflow')).toMatchObject({ state: 'pending' })
    expect(db.getRemoteDispatchAttachment('ctx_remote_overflow')).toBeDefined()
  })

  it('accepts a worker beyond the previous pending limit', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'capacity check' })
    insertMutationReceipts(db, PREVIOUS_RECEIPT_LIMIT + 1, 'pending')

    db.createStartingWorkerDispatch({
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
    expect(db.getTask(task.id)).toMatchObject({ status: 'dispatched' })
    expect(db.getMutationReceipt('caller', 'worker_overflow')).toMatchObject({ state: 'pending' })
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

describe('OrchestrationDb dispatch assignee index migration', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('migrates a populated upstream v23 database idempotently', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-dispatch-index-migration-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    const task = db.createTask({
      runId: 'run_legacy_local',
      spec: 'indexed lookup'
    })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    db.close()
    db = undefined

    const oldDb = new Database(dbPath)
    oldDb.exec(`
      DROP INDEX IF EXISTS idx_dispatch_active_assignee_handle;
      DROP INDEX IF EXISTS idx_dispatch_assignee_pane_leaf;
      ALTER TABLE tasks DROP COLUMN created_by_pane_key;
      ALTER TABLE tasks DROP COLUMN created_by_process_incarnation;
      ALTER TABLE tasks DROP COLUMN created_by_run_generation;
    `)
    oldDb.pragma('user_version = 23')
    oldDb.close()

    db = new OrchestrationDb(dbPath)
    const sqlite = sqliteFor(db)
    expect(sqlite.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(db.getDispatchContextById(dispatch.id)).toMatchObject({
      assignee_handle: 'term_worker'
    })
    expect(db.getTask(task.id)).toMatchObject({
      created_by_pane_key: null,
      created_by_process_incarnation: null,
      created_by_run_generation: null
    })
    expect(
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get('idx_dispatch_assignee_handle')
    ).toBeDefined()
    const plan = sqlite
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT * FROM dispatch_contexts
         WHERE assignee_handle = ? AND status IN ('pending', 'dispatched') LIMIT 1`
      )
      .all('term_worker') as { detail: string }[]
    expect(plan.map((row) => row.detail).join('\n')).toContain(
      'USING INDEX idx_dispatch_active_assignee_handle'
    )
    expect(
      sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get('idx_dispatch_active_assignee_handle')
    ).toMatchObject({
      sql: expect.stringContaining("status IN ('pending', 'dispatched')")
    })
    expect(
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get('idx_dispatch_assignee_pane_leaf')
    ).toBeDefined()

    db.close()
    db = new OrchestrationDb(dbPath)
    expect(sqliteFor(db).pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(db.getDispatchContextById(dispatch.id)).toBeDefined()
  })

  it('adds the active-handle index to a populated v24 database idempotently', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-active-dispatch-index-migration-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    const run = db.createRun({
      objective: 'retained v24 authority',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({
      spec: 'indexed lookup',
      runId: run.id,
      createdByTerminalHandle: 'term_creator',
      createdByPaneKey: 'tab_creator:leaf_creator',
      createdByProcessIncarnation: 'pty_creator:incarnation-a',
      createdByRunGeneration: run.consumer_generation
    })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    db.close()
    db = undefined

    const oldDb = new Database(dbPath)
    oldDb.exec('DROP INDEX IF EXISTS idx_dispatch_active_assignee_handle')
    oldDb.pragma('user_version = 24')
    oldDb.close()

    db = new OrchestrationDb(dbPath)
    const sqlite = sqliteFor(db)
    expect(sqlite.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(db.getTask(task.id)).toMatchObject({
      created_by_pane_key: 'tab_creator:leaf_creator',
      created_by_process_incarnation: 'pty_creator:incarnation-a',
      created_by_run_generation: 1
    })
    expect(db.getDispatchContextById(dispatch.id)).toMatchObject({
      assignee_handle: 'term_worker'
    })
    expect(
      sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get('idx_dispatch_active_assignee_handle')
    ).toMatchObject({
      sql: expect.stringContaining('assignee_handle IS NOT NULL')
    })

    db.close()
    db = new OrchestrationDb(dbPath)
    expect(sqliteFor(db).pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(db.getTask(task.id)?.created_by_process_incarnation).toBe('pty_creator:incarnation-a')
  })
})
