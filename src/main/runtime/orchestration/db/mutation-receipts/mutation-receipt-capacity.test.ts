import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../../../sqlite/sync-database'
import { OrchestrationDb } from '../orchestration-db'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'
import { MUTATION_RECEIPT_MAX_ROWS } from './mutation-receipt-capacity'

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
