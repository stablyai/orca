import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { openStructuredAgentSessionSqlJournalDatabase } from '../../runtime/agent-session/structured-agent-session-journal-open'
import { journalDatabasePath } from './database/journal-host-database'
import type { JournalSqlDatabase } from './database/journal-sql-database'
import { SqlAgentSessionJournal } from './journal-sql-store'
import type { JournalSqlStoreOperation } from './journal-sql-store'
import { JournalHostFactsNeededError } from './journal-writer-host-facts'
import type { JournalOperationReceipt } from './writing/journal-row-writer'
import { CommandReceiptExistsError } from './writing/command-receipt-transaction'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from './journal-sql-worker-bundle.test-fixture'

const roots: string[] = []
const databases: JournalSqlDatabase[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(databases.splice(0).map((database) => database.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const identity = {
  sessionId: 'session',
  workspaceId: 'workspace',
  hostId: 'host',
  agent: 'codex' as const,
  providerHandle: codexProviderHandle('thread')
}

const item = (text: string): JournalSqlStoreOperation => ({
  kind: 'item',
  identity: { provider: 'orca', clientMessageId: 'item' },
  body: { kind: 'status', text },
  options: { fence: 1, turnScope: { kind: 'thread' } }
})

async function open(root: string) {
  const errors: unknown[] = []
  const opened = await openStructuredAgentSessionSqlJournalDatabase({
    stateDirectory: root,
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath(),
    logger: { warn: () => {}, error: (_message, fields) => errors.push(fields.error) }
  })
  databases.push(opened.journalDatabase)
  expect(errors).toEqual([])
  return opened
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'journal-sql-store-'))
  roots.push(root)
  const { journalDatabase: database, records } = await open(root)
  expect(records.records.size).toBe(0)
  const journal = await SqlAgentSessionJournal.open({ database, identity, now: () => 100 })
  return { root, database, journal }
}

function receipt(adopt: (committed: boolean) => void, draft = 'retained'): JournalOperationReceipt {
  return {
    write: () => {
      throw new Error('the host must never write a SQL receipt')
    },
    committed: () => {
      throw new Error('the host must settle the staged receipt')
    },
    stage: async () => ({
      effects: [
        {
          kind: 'store',
          insertOperationsIfAbsent: false,
          writes: {
            records: {
              upsert: [['session', JSON.stringify({ schemaVersion: 999, draft })]],
              remove: []
            },
            operations: { upsert: [], remove: [] },
            retiredClaimKeys: null,
            sessionTabs: null
          }
        },
        {
          kind: 'receipt',
          scope: { kind: 'global' },
          receipt: {
            operationId: 'operation',
            sessionId: 'session',
            callerKey: 'caller',
            method: 'agentSession.send',
            fingerprint: 'fingerprint',
            acceptedAt: 100,
            status: 'accepted',
            result: { kind: 'journal-row', epoch: 'unassigned', sequence: 0 }
          },
          row: { at: 'first', kinds: ['item'], answer: 'journal-row' }
        }
      ],
      settle: (results) => adopt(results !== undefined)
    })
  }
}

it('adopts a row-bound receipt before publishing and reads the persisted revision after restart', async () => {
  const { root, database, journal } = await fixture()
  const opening = journal.openingCursor()
  expect(opening.sequence).toBe(1)
  expect(journal.wroteBeforeOpen(undefined)).toBe(false)
  expect(journal.wroteBeforeOpen(1)).toBe(true)
  let adopted = false
  const publications: boolean[] = []
  journal.observeCommits(() => publications.push(adopted))
  await journal.write(item('first'), () => ({
    receipt: receipt((committed) => {
      adopted = committed
    })
  }))
  expect(publications).toEqual([true])
  expect(journal.openingCursor()).toEqual(opening)
  expect(journal.cursor().sequence).toBe(2)
  expect(journal.wroteBeforeOpen(2)).toBe(false)
  expect(await database.readCommandReceipt({ kind: 'global' }, 'operation')).toMatchObject({
    verdict: 'readable',
    receipt: { result: { kind: 'journal-row', sequence: 2 } }
  })
  const revision = journal.write(item('revised'))
  const reading = journal.readInOrder((reads) => reads.item('orca:item'))
  const closed = journal.close()
  await expect(journal.write(item('after-close'))).rejects.toMatchObject({ code: 'journal_closed' })
  await revision
  expect(await reading).toMatchObject({ revision: 2, body: { text: 'revised' } })
  await closed
  await database.close()
  const reopened = await open(root)
  const next = await SqlAgentSessionJournal.open({ database: reopened.journalDatabase, identity })
  expect(next.wroteBeforeOpen(2)).toBe(true)
  expect(next.openingCursor().sequence).toBe(3)
  expect(next.observationHandle()).not.toBe(journal.observationHandle())
  expect(await next.reads.item('orca:item')).toMatchObject({
    revision: 2,
    body: { text: 'revised' }
  })
})

it('discards staged adoption and the row together when a receipt conflicts', async () => {
  const { database, journal } = await fixture()
  await journal.write(item('retained'), () => ({ receipt: receipt(() => {}) }))
  let adopted = true
  await expect(
    journal.write(item('must roll back'), () => ({
      receipt: receipt((committed) => {
        adopted = committed
      }, 'must roll back')
    }))
  ).rejects.toBeInstanceOf(CommandReceiptExistsError)
  expect(adopted).toBe(false)
  expect(await journal.reads.item('orca:item')).toMatchObject({
    revision: 1,
    body: { text: 'retained' }
  })
  expect(await database.readCommandReceipt({ kind: 'global' }, 'operation')).toMatchObject({
    verdict: 'readable',
    receipt: { result: { sequence: 2 } }
  })
  expect((await database.loadRecords()).unreadableRecords.get('session')).toEqual({
    reason: 'unsupported_schema',
    raw: { schemaVersion: 999, draft: 'retained' }
  })
})

it('releases a rolled-back stage before answering host facts and keeps the retry ahead of later commands', async () => {
  const { database, journal } = await fixture()
  await database.serialize('session', (writer) => {
    vi.spyOn(writer, 'write').mockRejectedValueOnce(
      new JournalHostFactsNeededError({
        rewound: { cursor: { epoch: 'proof', sequence: 8 }, cancel: null }
      })
    )
  })
  let released = false
  let adopted = false
  const retry = journal.write(
    item('retried'),
    () => ({
      receipt: receipt((committed) => {
        released = !committed
      })
    }),
    (_context, needs) => {
      expect(released).toBe(true)
      return {
        facts: { rewound: needs.rewound },
        receipt: receipt((committed) => {
          adopted = committed
        })
      }
    }
  )
  const next = journal.write(item('later'))
  await retry
  expect(adopted).toBe(true)
  await next
  expect(await journal.reads.item('orca:item')).toMatchObject({
    revision: 2,
    body: { text: 'later' }
  })
})

it('returns unanswered host-fact requests without replaying the command', async () => {
  const { database, journal } = await fixture()
  const needed = new JournalHostFactsNeededError({
    rewound: { cursor: { epoch: 'proof', sequence: 8 }, cancel: null }
  })
  await database.serialize('session', (writer) => {
    vi.spyOn(writer, 'write').mockRejectedValueOnce(needed)
  })
  let adopted = true
  await expect(
    journal.write(item('unanswered'), () => ({
      receipt: receipt((committed) => {
        adopted = committed
      })
    }))
  ).rejects.toBe(needed)
  expect(adopted).toBe(false)
  await journal.write(item('later'))
  expect(await journal.reads.item('orca:item')).toMatchObject({
    revision: 1,
    body: { text: 'later' }
  })
})

it('preserves a corrupt database on worker startup refusal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journal-sql-startup-'))
  roots.push(root)
  const path = journalDatabasePath(root)
  const bytes = Buffer.from('not a database '.repeat(512))
  await writeFile(path, bytes)
  await expect(open(root)).rejects.toMatchObject({
    refusal: { details: { reason: 'journalCorrupt' } }
  })
  expect(await readFile(path)).toEqual(bytes)
})
