import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../../../sqlite/sync-database'
import { openJournalDatabase, runJournalTransaction } from '../database/journal-database'
import {
  createAgentSessionRecordTablesSql,
  createJournalTablesSql,
  JOURNAL_DB_SCHEMA_VERSION
} from '../database/journal-database-schema'
import { journalDatabasePath } from '../database/journal-host-database'
import { closeTestJournalHostDatabases } from '../store-lifecycle/journal-host-database-test-support'
import { insertCommandReceiptIfAbsent, readCommandReceipt } from './command-receipt-table'
import { commandReceiptScope } from './command-receipt-schema'
import {
  commandReceiptFixture,
  writeCommandReceiptTestRecord
} from './command-receipt-test-support'
import { AgentSessionJournalError } from './journal-write-guards'
import { buildCommandReceiptTransaction } from './command-receipt-transaction'

export function registerCommandReceiptSchemaTests(): void {
  let root: string
  let dbPath: string
  const scope = commandReceiptScope('caller-1', 'global')

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-command-receipt-schema-'))
    dbPath = journalDatabasePath(root)
  })

  afterEach(async () => {
    await closeTestJournalHostDatabases()
    await rm(root, { recursive: true, force: true })
  })

  function hasReceiptTable(db: Database.Database): boolean {
    return Boolean(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('agent_session_command_receipts')
    )
  }

  describe('command receipts on a newer database', () => {
    it('reads receipts, refuses writes with the journal guard and leaves the file byte-identical', async () => {
      const seeded = openJournalDatabase(dbPath).db
      const receipt = commandReceiptFixture()
      runJournalTransaction(seeded, (db) => {
        writeCommandReceiptTestRecord(db)
        insertCommandReceiptIfAbsent(db, scope, receipt)
      })
      seeded.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION + 1}`)
      seeded.close()
      const before = await readFile(dbPath)

      const { db, readOnly } = openJournalDatabase(dbPath)
      try {
        expect(readOnly).toBe(true)
        expect(readCommandReceipt(db, scope, receipt.operationId)).toEqual({
          verdict: 'readable',
          receipt
        })
        const write = () => insertCommandReceiptIfAbsent(db, scope, receipt)
        expect(write).toThrow(AgentSessionJournalError)
        expect(write).toThrow(expect.objectContaining({ code: 'journal_read_only' }))
        expect(() => buildCommandReceiptTransaction(scope, receipt).write(db)).toThrow(
          expect.objectContaining({ code: 'journal_read_only' })
        )
      } finally {
        db.close()
      }

      expect(await readFile(dbPath)).toEqual(before)
      expect((await stat(`${dbPath}-wal`).catch(() => null))?.size ?? 0).toBe(0)
    })

    it('does not create a missing table or mistake unavailable proof for an absent command', async () => {
      const seeded = new Database(dbPath)
      seeded.exec(createJournalTablesSql())
      seeded.exec(createAgentSessionRecordTablesSql())
      seeded.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION + 1}`)
      seeded.close()
      const before = await readFile(dbPath)

      const { db } = openJournalDatabase(dbPath)
      try {
        const receipt = commandReceiptFixture()
        expect(hasReceiptTable(db)).toBe(false)
        expect(readCommandReceipt(db, scope, receipt.operationId)).toEqual({
          verdict: 'unreadable',
          scope,
          operationId: receipt.operationId
        })
      } finally {
        db.close()
      }
      expect(await readFile(dbPath)).toEqual(before)
    })
  })
}
