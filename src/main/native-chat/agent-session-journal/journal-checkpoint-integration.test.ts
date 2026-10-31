import { once } from 'node:events'
import { statSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Worker } from 'node:worker_threads'
import Database from '../../sqlite/sync-database'
import { JournalHostDatabase, journalDatabasePath } from './journal-host-database'
import { journalDatabaseHoldsAgentSessions } from './journal-database'
import { JOURNAL_DB_SCHEMA_VERSION } from './journal-database-schema'
import { journalCheckpointWorkerSource } from './journal-checkpoint-worker-source'
import type * as WorkerSource from './journal-checkpoint-worker-source'

// Read native configuration on the actual evaluated production connection, without a lifecycle ACK.
vi.mock('./journal-checkpoint-worker-source', async (original) => {
  const source = await original<typeof WorkerSource>()
  return {
    journalCheckpointWorkerSource: `
const sqlite = require('node:sqlite');
const nativePrepare = sqlite.DatabaseSync.prototype.prepare;
let configuration;
sqlite.DatabaseSync.prototype.prepare = function(sql) {
  if (sql === 'PRAGMA wal_checkpoint(NOOP)') {
    configuration = Object.fromEntries(['journal_mode', 'synchronous', 'checkpoint_fullfsync', 'journal_size_limit'].map(
      (name) => [name, Object.values(nativePrepare.call(this, 'PRAGMA ' + name).get())[0]]
    ));
  }
  return nativePrepare.call(this, sql);
};
const port = require('node:worker_threads').parentPort;
const nativePost = port.postMessage.bind(port);
port.postMessage = (message) => nativePost({ ...message, configuration });
${source.journalCheckpointWorkerSource}`
  }
})

let root: string
let host: JournalHostDatabase | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await host?.close()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})
async function open() {
  root = await mkdtemp(join(tmpdir(), 'orca-checkpoint-'))
  host = JournalHostDatabase.open(root)
  return host
}

it('moves checkpoints off the writer, retries a pinned idle tail, reclaims on reuse, and closes last', async () => {
  let checked: { log: number; checkpointed: number } | undefined
  const workers: Worker[] = []
  let exited = false
  const pending = new Set<number>()
  const post = Worker.prototype.postMessage
  vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, request) {
    if (workers.length === 0 && request?.type === 'check') {
      workers.push(this)
      this.on('exit', () => {
        exited = true
      })
      this.on('message', (message) => {
        if (message.type === 'checked') {
          checked = message
          pending.delete(message.id)
        }
      })
    }
    if (request?.type === 'check') {
      pending.add(request.id)
    }
    return post.call(this, request)
  })
  const database = await open()
  const db = database.db
  expect(db.pragma('wal_autocheckpoint', { simple: true })).toBe(0)
  await vi.waitFor(() => expect(checked).toBeDefined())
  expect(db.pragma('synchronous', { simple: true })).toBe(2)
  expect(db.pragma('checkpoint_fullfsync', { simple: true })).toBe(1)
  db.exec('CREATE TABLE checkpoint_probe (value BLOB)')
  db.pragma('journal_size_limit = 65536')
  database.transaction((writer) =>
    writer.exec('INSERT INTO checkpoint_probe VALUES (zeroblob(100))')
  )
  const reader = new Database(journalDatabasePath(root), { readonly: true })
  try {
    reader.exec('BEGIN; SELECT * FROM checkpoint_probe')
    for (let i = 0; i < 3; i++) {
      database.transaction((writer) =>
        writer.exec('INSERT INTO checkpoint_probe VALUES (zeroblob(200000))')
      )
    }
    const pinnedEnd = db.prepare('PRAGMA wal_checkpoint(NOOP)').get()!.log
    await vi.waitFor(() => {
      expect(checked?.log).toBe(pinnedEnd)
      expect(Number(checked?.log)).toBeGreaterThan(Number(checked?.checkpointed))
    })
    const pinned = db.prepare('PRAGMA wal_checkpoint(NOOP)').get()!
    expect(Number(pinned.log)).toBeGreaterThan(Number(pinned.checkpointed))
    reader.exec('COMMIT')
    // No new write: the worker must revisit the incomplete checkpoint and its small idle tail.
    await vi.waitFor(
      () => {
        const state = db.prepare('PRAGMA wal_checkpoint(NOOP)').get()!
        expect(state.log).toBe(state.checkpointed)
      },
      { timeout: 3000 }
    )
    database.transaction((writer) =>
      writer.exec('INSERT INTO checkpoint_probe VALUES (zeroblob(10))')
    )
    expect(statSync(`${journalDatabasePath(root)}-wal`).size).toBeLessThanOrEqual(65536)
  } finally {
    reader.close()
  }
  const [worker] = workers
  expect(worker).toBeDefined()
  let terminated = false
  const terminate = worker!.terminate.bind(worker)
  vi.spyOn(worker!, 'terminate').mockImplementation(async () => {
    const code = await terminate()
    terminated = true
    return code
  })
  const close = db.close.bind(db)
  vi.spyOn(db, 'close').mockImplementation(() => {
    expect(exited).toBe(true)
    expect(terminated).toBe(true)
    return close()
  })
  // Pending production work is retired before writer close; this does not prove an active native call.
  expect(pending.size).toBe(1)
  await database.close()
  await expect(stat(`${journalDatabasePath(root)}-wal`)).rejects.toMatchObject({ code: 'ENOENT' })
  host = JournalHostDatabase.open(root)
  expect(host.db.prepare('SELECT count(*) AS n FROM checkpoint_probe').get()?.n).toBe(5)
  expect(
    host.db
      .prepare(
        'SELECT length(value) AS bytes, value = zeroblob(length(value)) AS zeros FROM checkpoint_probe ORDER BY rowid'
      )
      .all()
  ).toEqual([100, 200000, 200000, 200000, 10].map((bytes) => ({ bytes, zeros: 1 })))
  expect(host.db.pragma('quick_check', { simple: true })).toBe('ok')
})

it.each(['ordinary', 'streamed', 'autocommit'])(
  'does not reject a committed %s write when maintenance fails',
  async (mode) => {
    let initialSettled = false
    const send = Worker.prototype.postMessage
    vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, request) {
      this.on('message', (message) => {
        if (message.type === 'checked' && message.id === request?.id) {
          initialSettled = true
        }
      })
      return send.call(this, request)
    })
    const database = await open()
    const db = database.db
    await vi.waitFor(() => expect(initialSettled).toBe(true))
    expect(db.pragma('wal_autocheckpoint', { simple: true })).toBe(0)
    db.exec('CREATE TABLE checkpoint_probe (value INTEGER)')
    const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(() => {
      throw new Error('post failed')
    })
    const pragma = db.pragma.bind(db)
    vi.spyOn(db, 'pragma').mockImplementation((sql, options) => {
      if (sql === 'wal_autocheckpoint = 1000') {
        throw new Error('fallback failed')
      }
      return pragma(sql, options)
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('log failed')
    })
    const insert = (writer: Database.Database) =>
      writer.exec('INSERT INTO checkpoint_probe VALUES (1)')
    expect(
      mode === 'autocommit'
        ? database.writeAutocommit(insert)
        : database.transaction(insert, mode === 'streamed')
    ).toBeUndefined()
    expect(post).toHaveBeenCalled()
    expect(db.prepare('SELECT count(*) AS n FROM checkpoint_probe').get()?.n).toBe(1)
    expect(db.pragma('synchronous', { simple: true })).toBe(2)
  }
)

it('never starts maintenance for probes or a newer read-only journal', async () => {
  const database = await open()
  database.db.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION + 1}`)
  await database.close()
  const worker = vi.spyOn(Worker.prototype, 'postMessage')
  journalDatabaseHoldsAgentSessions(journalDatabasePath(root))
  host = JournalHostDatabase.open(root)
  expect(host.readOnly).toBe(true)
  await host.close()
  expect(worker).not.toHaveBeenCalled()
})

it('configures the maintenance connection for full checkpoint flushing without changing journal mode', async () => {
  const database = await open()
  const worker = new Worker(journalCheckpointWorkerSource, {
    eval: true,
    workerData: { filename: journalDatabasePath(root), sizeLimit: 65536 }
  })
  const exited = once(worker, 'exit')
  worker.unref()
  try {
    const checked = once(worker, 'message')
    worker.postMessage({ type: 'check', id: 1 })
    expect((await checked)[0]).toMatchObject({
      type: 'checked',
      id: 1,
      configuration: {
        journal_mode: 'wal',
        synchronous: 2,
        checkpoint_fullfsync: 1,
        journal_size_limit: 65536
      }
    })
    expect(database.db.pragma('journal_mode', { simple: true })).toBe('wal')
  } finally {
    await worker.terminate()
    await exited
  }
})
