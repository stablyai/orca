import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { JournalHostDatabase } from './journal-host-database'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { AgentSessionJournal } from './journal-store'
import {
  insertTestJournalRow,
  publishTestJournalEpoch,
  corruptTestCommandReceipt
} from './journal-native-fixture-test-support'
import type { JournalRow } from './journal-row-schema'
import { JournalRowWriter } from './journal-row-writer'
import { JournalWriteQueue } from './journal-write-queue'
import { commandReceiptScope } from './command-receipt-schema'
import {
  commandReceiptFixture,
  writeCommandReceiptTestRecord
} from './command-receipt-test-support'
import {
  buildCommandReceiptTransaction,
  CommandReceiptExistsError
} from './command-receipt-transaction'

export function registerCommandReceiptTransactionTests(): void {
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
    database = await openTestJournalHostDatabase(root)
    await database.transaction((db) => {
      writeCommandReceiptTestRecord(db)
      publishTestJournalEpoch(db, identity.sessionId, 'epoch-1', identity.workspaceId)
    })
  })

  afterEach(async () => {
    await closeTestJournalHostDatabases()
    await rm(root, { recursive: true, force: true })
  })

  async function storedRows() {
    return await database.read((read) =>
      read.prepare('SELECT seq FROM journal_rows ORDER BY seq').all()
    )
  }

  function readReceipt() {
    return database.read(
      async (read) =>
        (await read.receipts(scope, [receipt.operationId])).get(receipt.operationId) ?? {
          verdict: 'absent' as const
        }
    )
  }

  describe('command receipt transaction hook', () => {
    it('rolls back the effect and receipt together if the enclosing transaction throws', async () => {
      const hook = buildCommandReceiptTransaction(scope, receipt)
      await expect(
        database.transaction((db) => {
          insertTestJournalRow(db, identity.sessionId, epochRow(1, 1000))
          hook.write(db)
          throw new Error('effect failed')
        })
      ).rejects.toThrow('effect failed')
      expect(await storedRows()).toEqual([])
      expect(await readReceipt()).toEqual({ verdict: 'absent' })
    })

    it('commits through the existing row writer with a pointer to the row it assigned', async () => {
      const queue = new JournalWriteQueue(identity.sessionId)
      const committed: JournalRow[] = []
      const writer = new JournalRowWriter({
        sessionId: identity.sessionId,
        now: () => 1000,
        serialize: (run) => queue.serialize(run),
        database: () => database,
        readOnly: () => database.readOnly,
        highestFence: () => 0,
        nextSequence: () => 7,
        commit: (rows) => committed.push(...rows)
      })
      await writer.enqueue(
        epochRow,
        buildCommandReceiptTransaction(scope, (row) => {
          if (!row) {
            throw new Error('expected the committed journal row')
          }
          return {
            ...receipt,
            result: { kind: 'journal-row', epoch: row.epoch, sequence: row.seq }
          }
        })
      )
      expect(committed).toHaveLength(1)
      expect(committed[0]).toEqual(epochRow(7, 1000))
      expect(await storedRows()).toEqual([{ seq: 7 }])
      expect(await readReceipt()).toEqual({
        verdict: 'readable',
        receipt: { ...receipt, result: { kind: 'journal-row', epoch: 'epoch-1', sequence: 7 } }
      })
    })

    it.each(['duplicate', 'conflict', 'unreadable'] as const)(
      'throws a typed %s verdict and rolls back the second effect',
      async (reason) => {
        await database.transaction((plan) =>
          buildCommandReceiptTransaction(scope, receipt).write(plan)
        )
        if (reason === 'unreadable') {
          await corruptTestCommandReceipt(database, receipt.operationId)
        }
        const hook = buildCommandReceiptTransaction(scope, {
          ...receipt,
          fingerprint: reason === 'conflict' ? 'changed' : receipt.fingerprint
        })
        const write = () =>
          database.transaction((db) => {
            insertTestJournalRow(db, identity.sessionId, epochRow(1, 1000))
            hook.write(db)
          })
        await expect(write()).rejects.toThrow(CommandReceiptExistsError)
        await expect(write()).rejects.toThrow(
          expect.objectContaining({ result: expect.objectContaining({ reason }) })
        )
        expect(await storedRows()).toEqual([])
        expect((await readReceipt()).verdict).toBe(
          reason === 'unreadable' ? 'unreadable' : 'readable'
        )
      }
    )
  })

  describe('command receipts across epoch replacement', () => {
    it('survives the actual replacement transaction without transferring or copying results', async () => {
      await database.transaction((db) => {
        insertTestJournalRow(db, identity.sessionId, epochRow(1, 1000))
        publishTestJournalEpoch(db, identity.sessionId, 'epoch-1', identity.workspaceId)
        buildCommandReceiptTransaction(scope, receipt).write(db)
      })
      const journal = new AgentSessionJournal({ database, identity })
      await journal.open()
      await journal.replaceEpochItems('legacy_import', 0, [])
      expect(
        await database.read((read) => read.prepare('SELECT epoch FROM journal_rows').all())
      ).toEqual([{ epoch: 'epoch-1' }, { epoch: 'epoch-1' }])
      await journal.close()
      expect(await readReceipt()).toEqual({ verdict: 'readable', receipt })
      await expect(
        database.transaction((plan) => buildCommandReceiptTransaction(scope, receipt).write(plan))
      ).rejects.toMatchObject({ result: { inserted: false, reason: 'duplicate' } })
    })
  })
}
