import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { openJournalDomainDatabase } from './database/journal-domain-database'
import { JournalSqlOwner } from './journal-sql-owner'
import {
  journalSqlWorkerPath,
  journalSqlReaderPath
} from './journal-sql-worker-bundle.test-fixture'
import { message } from './journal-sql-message.test-fixture'
import type { JournalSqlMessage } from './journal-sql-message-commit'
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
  const { db } = openJournalDomainDatabase(filename)
  for (const sessionId of sessionIds) {
    db.prepare(
      `INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence) VALUES('workspace',?,'epoch',1,1)`
    ).run(sessionId)
  }
  db.prepare('INSERT INTO agent_session_records VALUES (?, ?)').run('session', '{}')
  db.close()
  const owner = new JournalSqlOwner(filename, root, journalSqlWorkerPath())
  owners.push(owner)
  expect(await owner.opened()).toBe(false)
  return { root, filename, owner }
}

async function writeMessages(
  owner: JournalSqlOwner,
  command: {
    target: { sessionId: string; epoch: string }
    steps: readonly JournalSqlMessage[]
    savedAt: number
  }
) {
  const committed = await owner.write({
    target: { ...command.target, ownerToken: 'open-token' },
    savedAt: command.savedAt,
    operation: {
      kind: 'steps',
      steps: command.steps.map((step) => ({
        kind: 'resolved-item',
        reservedBytes: 1024,
        resolution: { kind: 'text-snapshot', identity: step.identity, body: step.body },
        options: step.options
      }))
    }
  })
  if (!committed.publication) {
    throw new Error('text steps omitted their committed payload')
  }
  return { ...committed.publication, cursor: committed.cursor }
}

it('uses the common writer transport and returns committed domain bodies in order', async () => {
  const { owner, filename } = await fixture()
  const probe = new Database(filename)
  const outcomes = await Promise.all(
    ['first', 'last'].map((text) =>
      writeMessages(owner, {
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
  expect(
    probe
      .prepare("SELECT name FROM sqlite_master WHERE name IN ('journal_rows','journal_outcomes')")
      .all()
  ).toEqual([])
  probe.close()
})

it('correlates interleaved replies and resumes current bodies after writer closure and replay pruning', async () => {
  const { owner, filename } = await fixture(['session', 'other'])
  const send = (sessionId: string, text: string) =>
    writeMessages(owner, {
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
  const pool = new JournalSqlReaderPool(filename, filename, journalSqlReaderPath())
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
  const reopened = new JournalSqlReaderPool(filename, filename, journalSqlReaderPath())
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
