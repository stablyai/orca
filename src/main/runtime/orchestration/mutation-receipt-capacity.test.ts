import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { MUTATION_RECEIPT_MAX_ROWS } from './mutation-receipt-capacity'
import { SCHEMA_VERSION } from './db/contract-constants'

function sqliteFor(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

function insertReceipts(
  sqlite: Database.Database,
  count: number,
  state: 'pending' | 'completed'
): void {
  sqlite
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

function beginReceipt(db: OrchestrationDb, requestId: string): void {
  db.beginMutationReceipt({
    callerFingerprint: 'new-caller',
    requestId,
    method: 'orchestration.send',
    payloadHash: `hash-${requestId}`
  })
}

describe('mutation receipt capacity schema', () => {
  let db: OrchestrationDb | undefined
  let secondDb: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    secondDb?.close()
    db?.close()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('uses the completed receipt index for age and capacity pruning', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = sqliteFor(db)
    insertReceipts(sqlite, 10, 'completed')

    const agePlan = sqlite
      .prepare(
        `EXPLAIN QUERY PLAN
         DELETE FROM mutation_receipts
         WHERE state = 'completed'
           AND updated_at < datetime('now', ?)`
      )
      .all('-30 days') as { detail: string }[]
    const capacityPlan = sqlite
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT rowid FROM mutation_receipts
         WHERE state = 'completed'
         ORDER BY updated_at ASC, rowid ASC
         LIMIT ?`
      )
      .all(64) as { detail: string }[]
    const details = [...agePlan, ...capacityPlan].map((row) => row.detail).join('\n')

    expect(details).toContain('idx_mutation_receipts_completed_updated')
    expect(details).not.toContain('USE TEMP B-TREE')
    expect(details).not.toMatch(/SCAN mutation_receipts(?:\n|$)/)
  })

  it('migrates a populated v25 database and tracks writes from older connections', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-mutation-receipt-migration-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    insertReceipts(sqliteFor(db), 20, 'completed')
    db.close()
    db = undefined

    const oldDb = new Database(dbPath)
    oldDb.exec(`
      DROP TRIGGER mutation_receipts_count_insert;
      DROP TRIGGER mutation_receipts_count_delete;
      DROP TABLE mutation_receipt_ledger;
      DROP INDEX idx_mutation_receipts_completed_updated;
    `)
    oldDb.pragma('user_version = 25')
    oldDb.close()

    db = new OrchestrationDb(dbPath)
    const sqlite = sqliteFor(db)
    expect(sqlite.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(sqlite.prepare('SELECT receipt_count FROM mutation_receipt_ledger').get()).toEqual({
      receipt_count: 20
    })

    const olderConnection = new Database(dbPath)
    olderConnection.exec(`
      INSERT INTO mutation_receipts (
        caller_fingerprint, request_id, method, payload_hash, state
      ) VALUES ('old-client', 'inserted', 'orchestration.send', 'hash', 'pending');
      DELETE FROM mutation_receipts
      WHERE caller_fingerprint = 'old-client' AND request_id = 'inserted';
    `)
    olderConnection.close()

    expect(sqlite.prepare('SELECT receipt_count FROM mutation_receipt_ledger').get()).toEqual({
      receipt_count: 20
    })
  })

  it('amortizes capacity pruning while retaining the newest replay records', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = sqliteFor(db)
    insertReceipts(sqlite, MUTATION_RECEIPT_MAX_ROWS, 'completed')

    beginReceipt(db, 'first')
    const afterFirst = sqlite
      .prepare('SELECT receipt_count FROM mutation_receipt_ledger')
      .get() as { receipt_count: number }
    beginReceipt(db, 'second')
    const afterSecond = sqlite
      .prepare('SELECT receipt_count FROM mutation_receipt_ledger')
      .get() as { receipt_count: number }

    expect(afterFirst.receipt_count).toBe(MUTATION_RECEIPT_MAX_ROWS - 63)
    expect(afterSecond.receipt_count).toBe(afterFirst.receipt_count + 1)
    expect(db.getMutationReceipt('caller', 'request_00064')).toBeUndefined()
    expect(db.getMutationReceipt('caller', 'request_00065')).toMatchObject({ state: 'completed' })
    expect(db.getMutationReceipt('caller', 'request_10000')).toMatchObject({ state: 'completed' })
  })

  it('keeps the row limit exact across independent database connections', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-mutation-receipt-concurrency-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    secondDb = new OrchestrationDb(dbPath)
    const sqlite = sqliteFor(db)
    insertReceipts(sqlite, MUTATION_RECEIPT_MAX_ROWS - 1, 'pending')
    sqlite.exec(`
      INSERT INTO mutation_receipts (
        caller_fingerprint, request_id, method, payload_hash, state
      ) VALUES ('caller', 'completed-slot', 'orchestration.send', 'hash', 'completed')
    `)

    beginReceipt(db, 'first-connection')
    expect(() => beginReceipt(secondDb!, 'second-connection')).toThrowError(
      expect.objectContaining({ code: 'mutation_ledger_full' })
    )
    db.discardPendingMutationReceipt('new-caller', 'first-connection')
    beginReceipt(secondDb, 'second-connection')

    expect(sqlite.prepare('SELECT receipt_count FROM mutation_receipt_ledger').get()).toEqual({
      receipt_count: MUTATION_RECEIPT_MAX_ROWS
    })
  })
})
