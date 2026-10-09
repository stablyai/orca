import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { JournalHostDatabase } from './journal-host-database'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { replaceJournalEpoch } from './journal-epoch-replacement'
import { runJournalTransaction } from './journal-database'
import {
  deleteJournalEpochRows,
  insertJournalRow,
  publishJournalSessionEpoch
} from './journal-row-table'
import type { JournalRow } from './journal-row-schema'
import { JournalRowWriter } from './journal-row-writer'
import { JournalWriteQueue } from './journal-write-queue'
import { insertCommandReceiptIfAbsent, readCommandReceipt } from './command-receipt-table'
import { commandReceiptScope, type CommandReceiptResult } from './command-receipt-schema'
import {
  commandReceiptFixture,
  writeCommandReceiptTestRecord
} from './command-receipt-test-support'
import {
  buildCommandReceiptTransaction,
  CommandReceiptExistsError
} from './command-receipt-transaction'

let root: string
let database: JournalHostDatabase
const receipt = commandReceiptFixture()
const scope = commandReceiptScope(receipt.callerKey, 'global')
const identity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex' as const,
  providerHandle: codexProviderHandle('thread-1')
}

function epochRow(seq: number, ts: number): JournalRow {
  return {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: 'epoch-1',
    seq,
    ts,
    fence: 0,
    kind: 'epoch',
    reason: 'session_created',
    providerHandle: { kind: 'codex', threadId: 'thread-1' }
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-command-receipt-transaction-'))
  database = openTestJournalHostDatabase(root)
  database.transaction((db) => {
    writeCommandReceiptTestRecord(db)
    publishJournalSessionEpoch(db, identity, 'epoch-1')
  })
})

afterEach(async () => {
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

function storedRows() {
  return database.db.prepare('SELECT seq FROM journal_rows ORDER BY seq').all()
}

function readReceipt() {
  return readCommandReceipt(database.db, scope, receipt.operationId)
}

describe('command receipt transaction hook', () => {
  it('rolls back the effect and receipt together if the enclosing transaction throws', () => {
    const hook = buildCommandReceiptTransaction(scope, receipt)
    expect(() =>
      runJournalTransaction(database.db, (db) => {
        insertJournalRow(db, identity.sessionId, epochRow(1, 1000))
        hook.write(db)
        throw new Error('effect failed')
      })
    ).toThrow('effect failed')
    expect(storedRows()).toEqual([])
    expect(readReceipt()).toEqual({ verdict: 'absent' })
    expect(database.db.isTransaction).toBe(false)
  })

  it('commits through the existing row writer with a pointer to the row it assigned', async () => {
    const queue = new JournalWriteQueue(identity.sessionId)
    const committed: JournalRow[] = []
    let result: CommandReceiptResult = { kind: 'journal-row', epoch: 'epoch-0', sequence: 99 }
    const writer = new JournalRowWriter({
      sessionId: identity.sessionId,
      now: () => 1000,
      serialize: (run) => queue.serialize(run),
      database: () => database,
      readOnly: () => database.readOnly,
      highestFence: () => 0,
      nextSequence: () => 7,
      commit: (row) => committed.push(row)
    })
    await writer.enqueue(
      epochRow,
      (_db, row) => {
        result = { kind: 'journal-row', epoch: row.epoch, sequence: row.seq }
      },
      buildCommandReceiptTransaction(scope, () => ({ ...receipt, result }))
    )
    expect(committed).toHaveLength(1)
    expect(storedRows()).toEqual([{ seq: 7 }])
    expect(readReceipt()).toEqual({
      verdict: 'readable',
      receipt: { ...receipt, result: { kind: 'journal-row', epoch: 'epoch-1', sequence: 7 } }
    })
  })

  it.each(['duplicate', 'conflict', 'unreadable'] as const)(
    'throws a typed %s verdict and rolls back the second effect',
    (reason) => {
      database.transaction((db) => insertCommandReceiptIfAbsent(db, scope, receipt))
      if (reason === 'unreadable') {
        database.db.prepare("UPDATE agent_session_command_receipts SET result_json = '{'").run()
      }
      const hook = buildCommandReceiptTransaction(scope, {
        ...receipt,
        fingerprint: reason === 'conflict' ? 'changed' : receipt.fingerprint
      })
      const write = () =>
        database.transaction((db) => {
          insertJournalRow(db, identity.sessionId, epochRow(1, 1000))
          hook.write(db)
        })
      expect(write).toThrow(CommandReceiptExistsError)
      expect(write).toThrow(
        expect.objectContaining({ result: expect.objectContaining({ reason }) })
      )
      expect(storedRows()).toEqual([])
      expect(readReceipt().verdict).toBe(reason === 'unreadable' ? 'unreadable' : 'readable')
    }
  )
})

describe('command receipts across epoch replacement', () => {
  it('survives deletion of its referenced journal epoch as retained spent proof', () => {
    database.transaction((db) => {
      insertJournalRow(db, identity.sessionId, epochRow(1, 1000))
      insertCommandReceiptIfAbsent(db, scope, receipt)
      deleteJournalEpochRows(db, identity.sessionId, 'epoch-1')
    })
    expect(storedRows()).toEqual([])
    expect(readReceipt()).toEqual({ verdict: 'readable', receipt })
  })

  it('survives the actual replacement transaction without transferring or copying results', () => {
    database.transaction((db) => {
      insertJournalRow(db, identity.sessionId, epochRow(1, 1000))
      insertCommandReceiptIfAbsent(db, scope, receipt)
    })
    replaceJournalEpoch({
      database,
      identity,
      reason: 'legacy_import',
      fence: 0,
      items: [],
      queuePause: { lifted: false, liveStop: null, reopened: false },
      now: () => 2000,
      mintEpoch: () => 'epoch-2',
      onPublished: () => undefined
    })
    expect(database.db.prepare('SELECT epoch FROM journal_rows').all()).toEqual([
      { epoch: 'epoch-2' }
    ])
    expect(readReceipt()).toEqual({ verdict: 'readable', receipt })
    expect(
      database.transaction((db) => insertCommandReceiptIfAbsent(db, scope, receipt))
    ).toMatchObject({
      inserted: false,
      reason: 'duplicate'
    })
  })
})
