import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { openJournalDatabase } from './database/journal-database'
import { seedJournalSqlCommands } from './journal-sql-command.test-fixture'
import { JournalSqlOwner } from './journal-sql-owner'
import {
  journalSqlWorkerPath,
  journalSqlReaderPath
} from './journal-sql-worker-bundle.test-fixture'
import { JournalSqlReducer } from './journal-sql-reducer'
import { JournalSqlScope } from './journal-sql-scope'
import type { JournalWriterCommand } from './journal-writer-command'
import type { CommandReceipt } from './writing/command-receipt-schema'
import { CommandReceiptExistsError } from './writing/command-receipt-transaction'
import { AgentSessionJournalError } from './writing/journal-write-guards'
import { AgentSessionAttachmentExpiredError } from '../agent-session-attachments/agent-session-attachment-claims'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { message } from './journal-sql-message.test-fixture'
import { JournalSqlReaderPool } from './journal-sql-reader-pool'

const roots: string[] = []
const owners: JournalSqlOwner[] = []
const readers: JournalSqlReaderPool[] = []
afterEach(async () => {
  await Promise.all(readers.splice(0).map((reader) => reader.close()))
  await Promise.all(owners.splice(0).map((owner) => owner.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(sessionIds = ['session']) {
  const root = await mkdtemp(join(tmpdir(), 'journal-sql-owner-'))
  roots.push(root)
  const filename = join(root, 'journal.db')
  const { db } = openJournalDatabase(filename)
  seedJournalSqlCommands(db)
  migrateJournalDomainSchema(db)
  for (const sessionId of sessionIds) {
    db.prepare(
      `INSERT INTO journal_chat_state(session_id,epoch,last_sequence,highest_fence) VALUES(?,'epoch',1,1)`
    ).run(sessionId)
  }
  db.prepare('INSERT INTO agent_session_records VALUES (?, ?)').run('session', '{}')
  db.close()
  const owner = new JournalSqlOwner(filename, root, journalSqlWorkerPath())
  owners.push(owner)
  expect(await owner.opened()).toBe(false)
  return { root, filename, owner }
}

const write = (text: string, fence = 1): JournalWriterCommand => ({
  target: { sessionId: 'session', epoch: 'epoch', ownerToken: 'open-token' },
  operation: {
    kind: 'item',
    identity: { provider: 'orca', clientMessageId: 'message' },
    body: { kind: 'status', text },
    options: { fence, turnScope: { kind: 'thread' } }
  }
})

it('uses the existing writer for domain messages and returns committed bodies without changing legacy data', async () => {
  const { owner, filename } = await fixture()
  const probe = new Database(filename)
  const legacy = () => probe.prepare('SELECT row_json FROM journal_rows ORDER BY seq').all()
  const before = legacy()
  const outcomes = await Promise.all(
    ['first', 'last'].map((text) =>
      owner.messages({
        target: { sessionId: 'session', epoch: 'epoch' },
        steps: [message(text)],
        savedAt: 100
      })
    )
  )
  expect(outcomes.map((commit) => commit.cursor)).toEqual([
    { epoch: 'epoch', sequence: 2 },
    { epoch: 'epoch', sequence: 3 }
  ])
  expect(outcomes.map((commit) => commit.items[0]?.body)).toEqual([
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'first' }] },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'last' }] }
  ])
  expect(legacy()).toEqual(before)
  probe.close()
})

it('correlates interleaved replies and resumes current bodies after writer closure and replay pruning', async () => {
  const { owner, filename } = await fixture(['session', 'other'])
  const send = (sessionId: string, text: string) =>
    owner.messages({
      target: { sessionId, epoch: 'epoch' },
      steps: [message(text)],
      savedAt: 100
    })
  await send('other', 'other first')
  const results = await Promise.allSettled([
    send('session', 'first'),
    send('other', 'other last'),
    send('session', 'last'),
    send('missing', 'refused')
  ])
  expect(results).toMatchObject([
    {
      status: 'fulfilled',
      value: {
        cursor: { epoch: 'epoch', sequence: 2 },
        items: [{ body: { blocks: [{ text: 'first' }] } }]
      }
    },
    {
      status: 'fulfilled',
      value: {
        cursor: { epoch: 'epoch', sequence: 3 },
        items: [{ body: { blocks: [{ text: 'other last' }] } }]
      }
    },
    {
      status: 'fulfilled',
      value: {
        cursor: { epoch: 'epoch', sequence: 3 },
        items: [{ body: { blocks: [{ text: 'last' }] } }]
      }
    },
    { status: 'rejected', reason: expect.any(Error) }
  ])
  const pool = new JournalSqlReaderPool(filename, journalSqlReaderPath())
  readers.push(pool)
  const request = {
    sessionId: 'session',
    direction: 'after',
    cursor: { epoch: 'epoch', sequence: 1 },
    limit: 10
  } as const
  expect(await pool.domainHistory(request)).toMatchObject({
    ok: true,
    page: {
      items: [{ itemId: 'orca:assistant', body: { blocks: [{ text: 'last' }] } }],
      liveCursor: { epoch: 'epoch', sequence: 3 }
    }
  })
  await owner.maintain({ kind: 'event-tail-prune', now: 86400100 })
  await owner.close()
  await pool.close()
  const reopened = new JournalSqlReaderPool(filename, journalSqlReaderPath())
  readers.push(reopened)
  const reset = await reopened.domainHistory(request)
  expect(reset).toMatchObject({
    ok: false,
    reset: 'cursor_compacted',
    page: {
      items: [{ itemId: 'orca:assistant', body: { blocks: [{ text: 'last' }] } }],
      liveCursor: { epoch: 'epoch', sequence: 3 }
    }
  })
  expect(reset.page.items).toHaveLength(1)
})

it('runs real source-worker commands in order, preserves typed receipt failures and joins close after admitted writes', async () => {
  const { owner, filename } = await fixture()
  const receipt: CommandReceipt = {
    operationId: 'operation',
    sessionId: 'session',
    callerKey: 'caller',
    method: 'agentSession.send',
    fingerprint: 'fingerprint',
    acceptedAt: 100,
    status: 'accepted',
    result: { kind: 'journal-row', epoch: 'unassigned', sequence: 1 }
  }
  const first = {
    ...write('first'),
    effects: [
      {
        kind: 'receipt' as const,
        scope: { kind: 'global' as const },
        receipt,
        row: { at: 'last' as const, answer: 'journal-row' as const }
      }
    ]
  }
  const admitted = [
    owner.write(first),
    owner.write(first),
    owner.write(write('stale', 0)),
    owner.write(write('last'))
  ]
  const settled = Promise.allSettled(admitted)
  const closed = owner.close()
  const results = await settled
  expect(results.map((result) => result.status)).toEqual([
    'fulfilled',
    'rejected',
    'rejected',
    'fulfilled'
  ])
  expect(results[1]).toMatchObject({
    status: 'rejected',
    reason: expect.any(CommandReceiptExistsError)
  })
  expect(results[2]).toMatchObject({
    status: 'rejected',
    reason: expect.any(AgentSessionJournalError)
  })
  expect(results[3]).toMatchObject({
    status: 'fulfilled',
    value: { cursor: { epoch: 'epoch', sequence: 3 } }
  })
  await closed
  await expect(owner.write(write('closed'))).rejects.toThrow('closing')
  const db = new Database(filename, { readonly: true })
  try {
    const state = new JournalSqlReducer(new JournalSqlScope(db, 'session', 'epoch'), 'epoch').state
    expect(state.lastSequence).toBe(3)
    expect(state.items.get('orca:message')?.body).toEqual({ kind: 'status', text: 'last' })
  } finally {
    db.close()
  }
})

it('rechecks a swept attachment inside the worker transaction and leaves the next command usable', async () => {
  const { owner, root } = await fixture()
  const uploadId = '0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c01'
  expect(
    await owner.effects([{ kind: 'sweep', operation: { kind: 'mark', uploadId, now: 100 } }])
  ).toEqual([true])
  await expect(
    owner.write({
      ...write('rolled back'),
      effects: [
        {
          kind: 'claim',
          claim: {
            sessionId: 'session',
            now: 100,
            required: true,
            body: {
              kind: 'message',
              role: 'user',
              blocks: [
                {
                  type: 'image-ref',
                  path: join(agentSessionAttachmentStoreRoot(root), uploadId, 'image.png')
                }
              ]
            }
          }
        }
      ]
    })
  ).rejects.toBeInstanceOf(AgentSessionAttachmentExpiredError)
  expect((await owner.write(write('survived'))).cursor.sequence).toBe(2)
})

it('answers a queued card across the worker boundary', async () => {
  const { owner } = await fixture()
  const body = {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text: 'queued' }]
  }
  const target = write('unused').target
  const inserted = await owner.write({
    target,
    operation: { kind: 'queue-insert', input: { messageId: 'queued', body } }
  })
  expect(inserted.value).toMatchObject({ messageId: 'queued', body, state: 'waiting' })
  const withdrawn = await owner.write({
    target,
    operation: { kind: 'queue-withdraw', messageIds: ['queued'] }
  })
  expect(withdrawn.value).toMatchObject([{ messageId: 'queued', body }])
})
