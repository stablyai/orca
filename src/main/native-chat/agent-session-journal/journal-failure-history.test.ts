import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { JournalSqlDatabase } from './database/journal-sql-database'
import { journalDomainDatabasePath } from './database/journal-domain-database'
import { openJournalDatabase } from './database/journal-database'
import { journalDatabasePath } from './database/journal-host-database'
import { publishJournalSessionEpoch } from './durable-rows/journal-row-table'
import { publishJournalOutcomeEpoch } from './outcomes/journal-outcome-epoch.test-fixture'
import { journalSqlRetryRows } from './journal-sql-retry-rows.test-fixture'
import {
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  AGENT_SESSION_JOURNAL_QUEUE_SCHEMA_VERSION
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from './journal-sql-worker-bundle.test-fixture'

const roots: string[] = []
const databases: JournalSqlDatabase[] = []
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('discovers historical waiting sessions in bounded pages and retains failure identity after source rebuild', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journal-failed-history-'))
  roots.push(root)
  const { db: source } = openJournalDatabase(journalDatabasePath(root))
  const rows = journalSqlRetryRows(true)
  rows.push({
    v: AGENT_SESSION_JOURNAL_QUEUE_SCHEMA_VERSION,
    epoch: 'epoch',
    seq: 999,
    ts: 199,
    fence: 1,
    kind: 'queue',
    messageId: 'saved-input',
    change: {
      op: 'queued',
      position: 99,
      queuedAt: null,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'saved work' }] }
    }
  })
  rows.push({
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: 'epoch',
    seq: 1000,
    ts: 200,
    fence: 1,
    kind: 'item',
    itemId: 'historical-failure',
    revision: 1,
    body: { kind: 'turn', turnId: 'historical-failure', state: 'completed', outcome: 'failure' }
  })
  for (let n = 0; n < 33; n++) {
    const sessionId = `saved-${String(n).padStart(2, '0')}`
    publishJournalSessionEpoch(source, { sessionId, workspaceId: 'workspace' }, 'epoch')
    publishJournalOutcomeEpoch(source, sessionId, 'epoch', rows)
  }
  source.close()
  const errors: unknown[] = []
  const open = async () => {
    const db = await JournalSqlDatabase.open(root, {
      readerPath: journalSqlReaderPath(),
      writerPath: journalSqlWorkerPath(),
      onMaintenanceError: (error) => errors.push(error)
    })
    databases.push(db)
    return db
  }
  const db = await open()
  const candidates = await db.readers.database({ kind: 'failed-candidates', after: null })
  expect(candidates).toMatchObject({ sessionIds: expect.arrayContaining(['saved-00', 'saved-31']) })
  expect(candidates).not.toMatchObject({ sessionIds: expect.arrayContaining(['saved-32']) })
  expect(await db.readers.database({ kind: 'failed-candidates', after: 'saved-31' })).toEqual({
    kind: 'failed-candidates',
    sessionIds: ['saved-32']
  })
  const published: string[] = []
  db.watchConverted((id) => published.push(id))
  await db.startMaintenance()
  expect(published).toContain('saved-32')
  const read = (database: JournalSqlDatabase) =>
    database.readers.point({
      sessionId: 'saved-32',
      operation: {
        kind: 'queue',
        operation: { kind: 'held-delivery', facts: { reopenFloor: null } }
      }
    })
  const expected = {
    kind: 'queue',
    result: {
      kind: 'held-delivery',
      delivery: {
        state: 'held',
        failureId: '3a5c390c2ecf8bf1c21e9cb2b7162cd2f8784d2cf5a96e34fb86259d5c984240',
        reason: { failure: 'unknown' }
      }
    }
  }
  expect(await read(db)).toMatchObject(expected)
  await db.close()
  for (const suffix of ['', '-wal', '-shm']) {
    await rm(journalDomainDatabasePath(root) + suffix, { force: true })
  }
  const rebuilt = await open()
  await rebuilt.startMaintenance()
  expect(await read(rebuilt)).toMatchObject(expected)
  expect(errors).toEqual([])
})
