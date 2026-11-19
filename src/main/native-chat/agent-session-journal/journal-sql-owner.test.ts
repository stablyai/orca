import { spawnProcess } from '@orca/process-host'
import { acquireJournalLegacyFileLock } from './journal-legacy-file-lock'
import { openJournalDatabase } from './database/journal-database'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import { ReaderSlot } from './journal-sql-reader-slot'

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

it.each([false, true])('cancels reader requests on requested close (ready: %s)', async (ready) => {
  const { filename } = await fixture()
  const slot = new ReaderSlot(filename, filename, journalSqlReaderPath())
  const operation = { kind: 'import-state', sessionId: 'session' } as const
  try {
    if (ready) {
      await slot.request(operation)
    }
    const cancelled = expect(slot.request(operation)).rejects.toMatchObject({
      name: 'AgentSessionJournalError',
      code: 'journal_closed'
    })
    await Promise.all([slot.close(), cancelled])
    await expect(slot.request(operation)).rejects.toMatchObject({
      name: 'AgentSessionJournalError',
      code: 'journal_closed'
    })
  } finally {
    await slot.close()
  }
})

it('rejects outstanding and later reader requests when the worker exits unexpectedly', async () => {
  const { root, filename } = await fixture()
  const workerPath = join(root, 'unexpected-reader-exit.cjs')
  await writeFile(
    workerPath,
    `const { parentPort } = require('node:worker_threads')
parentPort.on('message', () => process.exit(7))
parentPort.postMessage({ type: 'ready' })`
  )
  const slot = new ReaderSlot(filename, filename, workerPath)
  const operation = { kind: 'import-state', sessionId: 'session' } as const
  try {
    await expect(slot.request(operation)).rejects.toThrow('journal SQL reader exited (7)')
    await expect(slot.request(operation)).rejects.toThrow('journal SQL reader exited (7)')
  } finally {
    await slot.close()
  }
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

it('serves domain reads while source recycling yields to a new chat', async () => {
  const { filename, root } = await fixture()
  const pool = new JournalSqlReaderPool(
    filename,
    join(root, 'absent-legacy.db'),
    journalSqlReaderPath()
  )
  readers.push(pool)
  await pool.importState('session')
  const lease = await pool.recycleSourceReaders()
  expect(lease).not.toBeNull()
  const conversion = pool.prepareConversion('new-current-chat')
  expect(await pool.importState('session')).toMatchObject({ state: 'ready' })
  pool.releaseSourceReaders(lease!)
  expect(await conversion).toBeNull()
  expect(await pool.importState('session')).toMatchObject({ state: 'ready' })
})

it('heals a failed proof slot through the public pool without an unready chat', async () => {
  const { root, filename } = await fixture()
  const original = join(root, 'legacy.db')
  openJournalDatabase(original).db.close()
  const workerPath = join(root, 'proof-reader.cjs')
  await writeFile(
    workerPath,
    `const {parentPort}=require('node:worker_threads');
    parentPort.on('message',()=>process.exit(7));parentPort.postMessage({type:'ready'})`
  )
  const pool = new JournalSqlReaderPool(filename, original, workerPath)
  readers.push(pool)
  await expect(pool.legacyProof({ table: 0, after: null })).rejects.toThrow('reader exited (7)')
  await writeFile(workerPath, `require(${JSON.stringify(journalSqlReaderPath())})`)
  expect(await pool.legacyProof({ table: 0, after: null })).toEqual({
    next: { table: 1, after: null },
    sessions: []
  })
  const legacy = openJournalDatabase(original).db
  legacy.exec("INSERT INTO journal_rows VALUES('orphan','old',1,1,'unaccounted user text')")
  legacy.close()
  expect(await pool.legacyProof({ table: 1, after: null })).toMatchObject({
    retained: 'legacy source has orphan content'
  })
})

it('a source demand and pool close terminate an unresponsive helper before releasing the gate', async () => {
  const { root, filename } = await fixture()
  for (const action of ['demand', 'close'] as const) {
    const pool = new JournalSqlReaderPool(filename, join(root, 'absent.db'), journalSqlReaderPath())
    readers.push(pool)
    const lease = (await pool.recycleSourceReaders())!
    const started = Promise.withResolvers<void>()
    let child: ReturnType<typeof spawnProcess> | undefined
    const acquired = acquireJournalLegacyFileLock(filename, lease.signal, (spec) => {
      const spawned = spawnProcess({
        ...spec,
        program: process.execPath,
        args: ['-e', "process.stdout.write('fixture-ready');setInterval(()=>{},1000)"]
      })
      child = spawned
      spawned.stdout.once('data', () => started.resolve())
      return spawned
    })
      .catch(() => false)
      .finally(() => pool.releaseSourceReaders(lease))
    await started.promise
    if (action === 'demand') {
      expect(await pool.prepareConversion('new-chat')).toBeNull()
    } else {
      await pool.close()
    }
    expect(await acquired).toBe(false)
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true)
  }
})
