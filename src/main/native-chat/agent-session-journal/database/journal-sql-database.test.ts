import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { openJournalDatabase } from './journal-database'
import { journalDatabasePath } from './journal-host-database'
import { JournalSqlDatabase } from './journal-sql-database'
import { publishJournalSessionEpoch } from '../durable-rows/journal-row-table'
import { publishJournalOutcomeEpoch } from '../outcomes/journal-outcome-epoch.test-fixture'
import { journalSqlLifecycleRows } from '../journal-sql-reducer-rows.test-fixture'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from '../journal-sql-worker-bundle.test-fixture'
import type { JournalWriterEffect } from '../journal-writer-effects'
import { withTestAgentSessionDatabase } from '../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { CommandReceiptExistsError } from '../writing/command-receipt-transaction'

const roots: string[] = []
const databases: JournalSqlDatabase[] = []
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(saved: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'journal-sql-database-'))
  roots.push(root)
  const { db } = openJournalDatabase(journalDatabasePath(root))
  try {
    db.exec('BEGIN IMMEDIATE')
    for (const sessionId of saved) {
      publishJournalSessionEpoch(db, { sessionId, workspaceId: 'workspace' }, 'epoch')
      publishJournalOutcomeEpoch(db, sessionId, 'epoch', journalSqlLifecycleRows())
    }
    db.exec('COMMIT')
  } finally {
    db.close()
  }
  const errors: unknown[] = []
  const database = await open(root, errors)
  return { root, database, errors }
}

async function open(root: string, errors: unknown[]) {
  const database = await JournalSqlDatabase.open(root, {
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath(),
    onMaintenanceError: (error) => errors.push(error)
  })
  databases.push(database)
  return database
}

const identity = (sessionId: string) => ({
  sessionId,
  workspaceId: 'workspace',
  hostId: 'host',
  agent: 'codex' as const,
  providerHandle: codexProviderHandle('thread')
})
const history = (sessionId: string) => ({ sessionId, direction: 'tail' as const })

it('opens an unconverted chat while background work waits for live activity, then converts the rest', async () => {
  const { database, errors } = await fixture(['a', 'b'])
  database.setSessionActive('live-chat', true)
  const background = database.startMaintenance()
  await expect(database.readers.domainHistory(history('b'))).rejects.toThrow('without domain state')
  const opened = await database.openSession(identity('a'))
  expect(opened.target).toMatchObject({ sessionId: 'a', epoch: 'epoch' })
  expect(await database.readers.domainHistory(history('a'))).toMatchObject({
    ok: true,
    page: { sessionId: 'a', liveCursor: { sequence: 16 } }
  })
  await expect(database.readers.domainHistory(history('b'))).rejects.toThrow('without domain state')
  database.setSessionActive('live-chat', false)
  await background
  expect(await database.readers.domainHistory(history('b'))).toMatchObject({
    ok: true,
    page: { sessionId: 'b', liveCursor: { sequence: 16 } }
  })
  expect(errors).toEqual([])
})

it('serializes a new chat through its writer-assigned epoch and reads committed revisions after restart', async () => {
  const { root, database, errors } = await fixture()
  const { target } = await database.openSession(identity('new'))
  const append = (text: string) =>
    database.write({
      target,
      operation: {
        kind: 'item',
        identity: { provider: 'orca', clientMessageId: 'item' },
        body: { kind: 'status', text },
        options: { fence: 1, turnScope: { kind: 'thread' } }
      }
    })
  const first = append('first')
  const second = append('second')
  const read = database.serialize('new', () => database.readers.domainHistory(history('new')))
  expect((await first).items).toEqual([
    { itemId: 'orca:item', deleted: false, revision: 1, sequence: 1, sequenceIndex: 0 }
  ])
  expect((await second).items).toEqual([
    { itemId: 'orca:item', deleted: false, revision: 2, sequence: 1, sequenceIndex: 0 }
  ])
  expect(await read).toMatchObject({
    ok: true,
    page: {
      items: [{ itemId: 'orca:item', revision: 2, body: { kind: 'status', text: 'second' } }]
    }
  })
  await database.close()
  const reopened = await open(root, errors)
  await reopened.openSession(identity('new'))
  expect(await reopened.readers.domainHistory(history('new'))).toMatchObject({
    ok: true,
    page: {
      items: [{ itemId: 'orca:item', revision: 2, body: { kind: 'status', text: 'second' } }]
    }
  })
  expect(errors).toEqual([])
})

it('rolls back tab changes with a conflicting receipt while preserving unreadable records', async () => {
  const { database, root } = await fixture()
  const receipt: JournalWriterEffect = {
    kind: 'receipt',
    scope: { kind: 'global' },
    receipt: {
      operationId: 'operation',
      sessionId: 'held-session',
      callerKey: 'caller',
      method: 'agentSession.send',
      fingerprint: 'fingerprint',
      acceptedAt: 100,
      status: 'accepted',
      result: { kind: 'journal-row', epoch: 'epoch', sequence: 1 }
    }
  }
  await withTestAgentSessionDatabase(root, (db) => {
    db.prepare('INSERT INTO agent_session_records(session_id,record_json) VALUES(?,?)').run(
      'held-session',
      '{"schemaVersion":999}'
    )
    db.prepare('INSERT INTO agent_session_tabs(tab_id,session_id,position) VALUES(?,?,0)').run(
      'original',
      'held-session'
    )
    db.prepare(
      "INSERT INTO agent_session_store_meta(key,value) VALUES('session_tabs_recorded','1')"
    ).run()
  })
  await database.effects([receipt])
  await expect(
    database.effects([
      {
        kind: 'store',
        mutation: {
          input: {
            kind: 'command',
            command: {
              kind: 'tab-visibility',
              sessionId: 'held-session',
              visible: false,
              legacyTabIds: []
            }
          }
        }
      },
      receipt
    ])
  ).rejects.toBeInstanceOf(CommandReceiptExistsError)
  const records = await database.loadRecords()
  expect(records.unreadableRecords.get('held-session')).toEqual({
    reason: 'unsupported_schema',
    raw: { schemaVersion: 999 }
  })
  expect(records.sessionTabs?.entries()).toEqual([['original', 'held-session']])
  expect(records.sessionTabs?.tabIdFor('held-session')).toBe('original')
  expect(await database.readCommandReceipt({ kind: 'global' }, 'operation')).toMatchObject({
    verdict: 'readable',
    receipt: { acceptedAt: 100, result: { kind: 'journal-row', epoch: 'epoch', sequence: 1 } }
  })
})

it('reads full item detail and provenance independently of bounded history, retaining publication after removal', async () => {
  const { database } = await fixture()
  const { target } = await database.openSession(identity('detail'))
  const output = {
    head: 'é'.repeat(20000),
    byteLength: 40000,
    digest: '0'.repeat(64),
    truncated: false
  }
  await database.write({
    target,
    operation: {
      kind: 'item',
      identity: { provider: 'orca', clientMessageId: 'tool' },
      body: { kind: 'tool-call', name: 'read', input: {}, output, state: 'completed' },
      options: {
        fence: 1,
        executionOwner: 7,
        echoOf: null,
        turnScope: { kind: 'thread' }
      }
    }
  })
  expect(
    await database.readers.point({
      sessionId: 'detail',
      operation: { kind: 'item', itemId: 'orca:tool' }
    })
  ).toMatchObject({
    kind: 'item',
    item: { itemId: 'orca:tool', revision: 1, body: { output } }
  })
  expect(await database.readers.domainHistory(history('detail'))).toMatchObject({
    ok: true,
    page: { items: [{ shortened: true, body: { output: { truncated: true } } }] }
  })
  expect(
    await database.readers.point({
      sessionId: 'detail',
      operation: { kind: 'item-provenance', itemId: 'orca:tool' }
    })
  ).toEqual({
    kind: 'item-provenance',
    provenance: { ownerFence: 1, executionOwner: 7, echoOf: null }
  })
  await database.write({
    target,
    operation: {
      kind: 'tombstone',
      identity: { provider: 'orca', clientMessageId: 'tool' },
      fence: 1
    }
  })
  expect(
    await database.readers.point({
      sessionId: 'detail',
      operation: { kind: 'item', itemId: 'orca:tool' }
    })
  ).toEqual({ kind: 'item', item: null })
  expect(
    await database.readers.point({
      sessionId: 'detail',
      operation: { kind: 'has-recorded-item', itemId: 'orca:tool' }
    })
  ).toEqual({ kind: 'has-recorded-item', recorded: true })
})

it('replays late revisions and removals in write order while preserving their original timeline positions', async () => {
  const { database } = await fixture()
  const { target } = await database.openSession(identity('replay'))
  const append = (id: string, text: string) =>
    database.write({
      target,
      operation: {
        kind: 'item',
        identity: { provider: 'orca', clientMessageId: id },
        body: { kind: 'status', text },
        options: { fence: 1, turnScope: { kind: 'thread' } }
      }
    })
  await append('older', 'first')
  const held = (await append('removed', 'second')).cursor
  await append('older', 'revised')
  await database.write({
    target,
    operation: {
      kind: 'tombstone',
      identity: { provider: 'orca', clientMessageId: 'removed' },
      fence: 1
    }
  })
  await append('newest', 'third')
  const read = (sequence: number) =>
    database.readers.domainHistory({
      sessionId: 'replay',
      direction: 'after',
      cursor: { epoch: held.epoch, sequence },
      limit: 1
    })
  expect(await read(2)).toMatchObject({
    ok: true,
    page: {
      items: [{ itemId: 'orca:older', sequence: 1, revision: 2, body: { text: 'revised' } }],
      removedItemIds: [],
      window: { nextCursor: { sequence: 3 } },
      hasNewer: true
    }
  })
  expect(await read(3)).toMatchObject({
    ok: true,
    page: {
      items: [],
      removedItemIds: ['orca:removed'],
      window: { nextCursor: { sequence: 4 } },
      hasNewer: true
    }
  })
  expect(await read(4)).toMatchObject({
    ok: true,
    page: {
      items: [{ itemId: 'orca:newest', sequence: 5, revision: 1, body: { text: 'third' } }],
      removedItemIds: [],
      window: { nextCursor: { sequence: 5 } },
      hasNewer: false
    }
  })
})
