import { runProcess } from '@orca/process-host'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { openJournalDomainDatabase } from './database/journal-domain-database'
import { JournalSqlOwner } from './journal-sql-owner'
import { prepareJournalSqlRequest } from './journal-sql-ready-batch'
import { journalSqlWorkerPath } from './journal-sql-worker-bundle.test-fixture'
import type { JournalWriterCommand } from './journal-writer-command'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function toolOutput(sessionId: string, callId: string): JournalWriterCommand {
  const identity = { provider: 'orca' as const, clientMessageId: callId }
  const body = {
    kind: 'tool-call',
    name: 'shell',
    callId,
    input: { command: 'cat build.log' },
    state: 'completed'
  } as const
  return {
    target: { sessionId, epoch: 'epoch', ownerToken: 'owner' },
    savedAt: 100,
    operation: {
      kind: 'steps',
      steps: [
        {
          kind: 'resolved-item',
          reservedBytes: Buffer.byteLength(JSON.stringify({ identity, body })) + 512,
          options: { fence: 1, turnScope: { kind: 'thread' } },
          resolution: { kind: 'literal', identity, body }
        }
      ]
    }
  }
}

const write = (id: number, command: JournalWriterCommand) =>
  prepareJournalSqlRequest(id, { type: 'write', command })

// The writer process is killed outright between two commands of one transaction.
const CRASH_WORKER = `
const { DatabaseSync } = require('node:sqlite')
const exec = DatabaseSync.prototype.exec
let applied = 0
DatabaseSync.prototype.exec = function (sql) {
  if (sql === 'BEGIN IMMEDIATE') applied = 0
  if (sql === 'RELEASE journal_command' && ++applied === 2) {
    process.kill(process.pid, 'SIGKILL')
    // Delivery can lag the call; hold this thread so COMMIT never runs first.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  }
  return exec.call(this, sql)
}
require(process.env.JOURNAL_WRITER)
`
const DRIVER = `
const { Worker } = require('node:worker_threads')
const [crashWorker, filename, stateDirectory, first, burst] = process.argv.slice(2)
const worker = new Worker(crashWorker, { workerData: { filename, stateDirectory } })
let replies = 0
worker.on('message', (response) => {
  require('node:fs').writeSync(1, JSON.stringify({ type: response.type, id: response.id }) + '\\n')
  if (response.type === 'ready') worker.postMessage(JSON.parse(first))
  if (response.id === 1) for (const request of JSON.parse(burst)) worker.postMessage(request)
  if (++replies === 4) process.exit(0)
})
`

function itemIds(filename: string): string[] {
  const db = new Database(filename)
  try {
    return db
      .prepare(`SELECT item_id FROM journal_items WHERE session_id LIKE 'chat-%' ORDER BY item_id`)
      .all()
      .map((row) => String(row.item_id))
  } finally {
    db.close()
  }
}

it('a crash inside a batch of tool outputs from several chats acknowledges and keeps none of them, and the restarted writer accepts them again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journal-item-batch-crash-'))
  roots.push(root)
  const filename = join(root, 'journal.db')
  const { db } = openJournalDomainDatabase(filename)
  for (const sessionId of ['chat-a', 'chat-b', 'chat-c']) {
    db.prepare(
      `INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence) VALUES('workspace',?,'epoch',1,1)`
    ).run(sessionId)
  }
  db.close()
  await writeFile(join(root, 'crash-worker.cjs'), CRASH_WORKER)
  await writeFile(join(root, 'driver.cjs'), DRIVER)

  const crashed = await runProcess({
    program: process.execPath,
    args: [
      join(root, 'driver.cjs'),
      join(root, 'crash-worker.cjs'),
      filename,
      root,
      JSON.stringify(write(1, toolOutput('chat-a', 'a1'))),
      JSON.stringify([write(2, toolOutput('chat-b', 'b1')), write(3, toolOutput('chat-c', 'c1'))])
    ],
    env: { ...process.env, JOURNAL_WRITER: journalSqlWorkerPath() },
    timeoutMs: 30_000
  })
  const replies = crashed.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(crashed.signal ?? crashed.code).not.toBe(0)
  expect(replies).toEqual([{ type: 'ready' }, { type: 'committed', id: 1 }])
  expect(itemIds(filename)).toEqual(['orca:a1'])

  const owner = new JournalSqlOwner(filename, root, journalSqlWorkerPath())
  try {
    expect(await owner.opened()).toBe(false)
    await Promise.all([
      owner.write(toolOutput('chat-b', 'b1')),
      owner.write(toolOutput('chat-c', 'c1'))
    ])
  } finally {
    await owner.close()
  }
  expect(itemIds(filename)).toEqual(['orca:a1', 'orca:b1', 'orca:c1'])
})

it('a full disk that rolls back a batch of several chats reruns each write alone, so the others still commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journal-item-batch-full-'))
  roots.push(root)
  const filename = join(root, 'journal.db')
  const { db } = openJournalDomainDatabase(filename)
  for (const sessionId of ['chat-b', 'chat-c']) {
    db.prepare(
      `INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence) VALUES('workspace',?,'epoch',1,1)`
    ).run(sessionId)
  }
  db.close()
  // Any transaction holding two chats' writes runs out of space and SQLite rolls it back.
  const fullWorker = join(root, 'full-worker.cjs')
  await writeFile(
    fullWorker,
    `const { DatabaseSync } = require('node:sqlite')
const exec = DatabaseSync.prototype.exec
let applied = 0
DatabaseSync.prototype.exec = function (sql) {
  if (sql === 'BEGIN IMMEDIATE') applied = 0
  if (sql === 'RELEASE journal_command' && ++applied === 2) {
    exec.call(this, 'ROLLBACK')
    throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 })
  }
  return exec.call(this, sql)
}
require(${JSON.stringify(journalSqlWorkerPath())})`
  )
  const owner = new JournalSqlOwner(filename, root, fullWorker)
  try {
    expect(await owner.opened()).toBe(false)
    const written = await Promise.allSettled([
      owner.write(toolOutput('chat-b', 'b1')),
      owner.write(toolOutput('chat-c', 'c1'))
    ])
    expect(written.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
  } finally {
    await owner.close()
  }
  expect(itemIds(filename)).toEqual(['orca:b1', 'orca:c1'])
})
