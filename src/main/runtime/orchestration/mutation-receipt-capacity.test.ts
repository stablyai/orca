import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { SCHEMA_VERSION } from './db/contract-constants'
import { MUTATION_RECEIPT_PRUNE_RULES } from './mutation-receipt-maintenance'

const PREVIOUS_RECEIPT_LIMIT = 10_000

function sqliteFor(db: OrchestrationDb): Database.Database {
  return db.db
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

  it('serves every maintenance statement from a receipt index without a sort', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = sqliteFor(db)
    insertReceipts(sqlite, 10, 'completed')

    for (const rule of MUTATION_RECEIPT_PRUNE_RULES) {
      const details = sqlite
        .prepare(`EXPLAIN QUERY PLAN ${rule.sql}`)
        .all(...rule.params, 256)
        .map((row) => String(row.detail))
        .join('\n')

      expect(details).toMatch(/idx_mutation_receipts_(completed|pending)_updated/)
      expect(details).not.toContain('USE TEMP B-TREE')
      expect(details).not.toMatch(/SCAN mutation_receipts(?:\n|$)/)
    }
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

  it('retains replay records beyond the previous count limit', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = sqliteFor(db)
    insertReceipts(sqlite, PREVIOUS_RECEIPT_LIMIT, 'completed')

    beginReceipt(db, 'first')
    const afterFirst = sqlite
      .prepare('SELECT receipt_count FROM mutation_receipt_ledger')
      .get() as { receipt_count: number }
    beginReceipt(db, 'second')
    const afterSecond = sqlite
      .prepare('SELECT receipt_count FROM mutation_receipt_ledger')
      .get() as { receipt_count: number }

    expect(afterFirst.receipt_count).toBe(PREVIOUS_RECEIPT_LIMIT + 1)
    expect(afterSecond.receipt_count).toBe(afterFirst.receipt_count + 1)
    expect(db.getMutationReceipt('caller', 'request_00064')).toMatchObject({ state: 'completed' })
    expect(db.getMutationReceipt('caller', 'request_00065')).toMatchObject({ state: 'completed' })
    expect(db.getMutationReceipt('caller', 'request_10000')).toMatchObject({ state: 'completed' })
  })

  it('admits fresh receipts across independent connections past the previous limit', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-mutation-receipt-concurrency-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    secondDb = new OrchestrationDb(dbPath)
    const sqlite = sqliteFor(db)
    insertReceipts(sqlite, PREVIOUS_RECEIPT_LIMIT - 1, 'pending')
    sqlite.exec(`
      INSERT INTO mutation_receipts (
        caller_fingerprint, request_id, method, payload_hash, state
      ) VALUES ('caller', 'completed-slot', 'orchestration.send', 'hash', 'completed')
    `)

    beginReceipt(db, 'first-connection')
    beginReceipt(secondDb, 'second-connection')

    expect(sqlite.prepare('SELECT receipt_count FROM mutation_receipt_ledger').get()).toEqual({
      receipt_count: PREVIOUS_RECEIPT_LIMIT + 2
    })
  })
})
