import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { journalPragmaNumber, openJournalDatabase, runJournalTransaction } from './journal-database'
import {
  createAgentSessionRecordTablesSql,
  createJournalTablesSql,
  JOURNAL_DB_SCHEMA_VERSION
} from './journal-database-schema'
import { journalDatabasePath } from './journal-host-database'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { insertCommandReceiptIfAbsent, readCommandReceipt } from './command-receipt-table'
import { commandReceiptScope } from './command-receipt-schema'
import {
  commandReceiptFixture,
  writeCommandReceiptTestRecord
} from './command-receipt-test-support'
import { AgentSessionJournalError } from './journal-write-guards'
import { buildCommandReceiptTransaction } from './command-receipt-transaction'

let root: string
let dbPath: string
const scope = commandReceiptScope('caller-1', 'global')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-command-receipt-schema-'))
  dbPath = journalDatabasePath(root)
})

afterEach(async () => {
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

function hasReceiptTable(db: Database.Database): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('agent_session_command_receipts')
  )
}

describe('command receipt schema at writable open', () => {
  it('creates the operation/caller primary key and session index on a fresh host database', () => {
    const database = openTestJournalHostDatabase(root)
    expect(hasReceiptTable(database.db)).toBe(true)
    expect(journalPragmaNumber(database.db, 'user_version')).toBe(JOURNAL_DB_SCHEMA_VERSION)
    expect(database.db.prepare('PRAGMA table_info(agent_session_command_receipts)').all()).toEqual([
      expect.objectContaining({ name: 'operation_id', pk: 1 }),
      expect.objectContaining({ name: 'session_id', pk: 0 }),
      expect.objectContaining({ name: 'caller_key', pk: 2 }),
      expect.objectContaining({ name: 'method', pk: 0 }),
      expect.objectContaining({ name: 'fingerprint', pk: 0 }),
      expect.objectContaining({ name: 'status', pk: 0 }),
      expect.objectContaining({ name: 'result_json', pk: 0 }),
      expect.objectContaining({ name: 'rejection_json', pk: 0 }),
      expect.objectContaining({ name: 'accepted_at', pk: 0 })
    ])
    const indexes = database.db.prepare('PRAGMA index_list(agent_session_command_receipts)').all()
    expect(indexes).toHaveLength(2)
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'sqlite_autoindex_agent_session_command_receipts_1',
          origin: 'pk'
        }),
        expect.objectContaining({ name: 'agent_session_command_receipts_session', origin: 'c' })
      ])
    )
    expect(
      database.db.prepare('PRAGMA index_info(agent_session_command_receipts_session)').all()
    ).toEqual([expect.objectContaining({ name: 'session_id' })])
    expect(
      database.db.prepare('PRAGMA foreign_key_list(agent_session_command_receipts)').all()
    ).toEqual([
      expect.objectContaining({
        table: 'agent_session_records',
        from: 'session_id',
        to: 'session_id',
        on_delete: 'CASCADE'
      })
    ])
  })

  it.each([3, 4])('adds the table to an older-shaped version %i database', (version) => {
    const seeded = new Database(dbPath)
    seeded.exec(createJournalTablesSql())
    if (version === 4) {
      seeded.exec(createAgentSessionRecordTablesSql())
      writeCommandReceiptTestRecord(seeded)
    }
    seeded.pragma(`user_version = ${version}`)
    expect(hasReceiptTable(seeded)).toBe(false)
    seeded.close()

    for (let open = 0; open < 2; open += 1) {
      const { db, readOnly } = openJournalDatabase(dbPath)
      try {
        expect(readOnly).toBe(false)
        expect(hasReceiptTable(db)).toBe(true)
        expect(journalPragmaNumber(db, 'user_version')).toBe(4)
        if (version === 4) {
          expect(db.prepare('SELECT session_id FROM agent_session_records').all()).toEqual([
            { session_id: 'session-1' }
          ])
        }
      } finally {
        db.close()
      }
    }
  })
})

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
