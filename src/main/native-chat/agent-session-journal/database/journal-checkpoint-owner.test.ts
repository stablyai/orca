import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../../sqlite/sync-database'
import { JournalSqlBatch } from '../journal-sql-batch'
import { JournalCheckpointOwner } from './journal-checkpoint-owner'
import { journalCheckpointWorkerSource } from './journal-checkpoint-worker-source'

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const step of cleanup.splice(0).toReversed()) {
    await step()
  }
})

it('replaces a checkpoint worker that dies, and the replacement checkpoints the WAL', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const root = mkdtempSync(join(tmpdir(), 'journal-checkpoint-restart-'))
  cleanup.push(() => rmSync(root, { recursive: true }))
  const filename = join(root, 'chat.db')
  const writer = new Database(filename)
  cleanup.push(() => writer.close())
  writer.exec(`PRAGMA page_size=512; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
    CREATE TABLE writes(id INTEGER PRIMARY KEY, body BLOB);`)
  const workers: Worker[] = []
  const owner = new JournalCheckpointOwner(writer, filename, {
    restartDelayMs: 10,
    factory: () => {
      const worker = new Worker(journalCheckpointWorkerSource, {
        eval: true,
        workerData: { filename, frames: 1000, retryMs: 10, pinnedRetryMs: 10 }
      })
      workers.push(worker)
      return worker
    }
  })
  cleanup.push(() => owner.close())
  // ~3000 frames each: past the worker's threshold; the writer's own autocheckpoint is off while one answers.
  const checkpointedBy = async (id: number) => {
    writer.prepare('INSERT INTO writes VALUES(?, zeroblob(1500000))').run(id)
    owner.afterCommit()
    await vi.waitFor(() => {
      const state = writer.prepare('PRAGMA wal_checkpoint(NOOP)').get()
      expect(Number(state?.log)).toBeGreaterThan(1000)
      expect(state?.checkpointed).toBe(state?.log)
    })
  }
  await checkpointedBy(1)
  await workers[0]!.terminate()

  await vi.waitFor(() => expect(workers).toHaveLength(2))
  await checkpointedBy(2)
})

it('close waits for a retiring idle worker even after a new worker replaced it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'journal-checkpoint-retire-'))
  cleanup.push(() => rmSync(root, { recursive: true }))
  const filename = join(root, 'chat.db')
  const writer = new Database(filename)
  cleanup.push(() => writer.close())
  writer.exec(`PRAGMA page_size=512; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
    CREATE TABLE writes(id INTEGER PRIMARY KEY, body BLOB);`)
  type Fake = EventEmitter & {
    postMessage: (message: { type: string; id?: number }) => void
    unref: () => void
    terminate: () => Promise<number>
    exit: () => void
    stopped: boolean
  }
  const fakes: Fake[] = []
  const makeFake = (): Fake => {
    const connection = new Database(filename)
    // Only the first worker answers its startup check, so it goes idle and retires; close stops the second.
    const answers = fakes.length === 0
    const fake: Fake = Object.assign(new EventEmitter(), {
      stopped: false,
      postMessage(message: { type: string; id?: number }) {
        if (message.type === 'stop') {
          connection.close()
          fake.stopped = true
          return
        }
        connection.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()
        fake.emit('message', { type: 'checked', id: message.id, ran: true })
      },
      unref: () => {},
      terminate: async () => {
        fake.exit()
        return 0
      },
      exit: () => fake.emit('exit', 0)
    })
    queueMicrotask(() => {
      if (fake.stopped || !answers) {
        return
      }
      connection.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()
      fake.emit('message', { type: 'checked', id: 0, ran: true })
    })
    fakes.push(fake)
    return fake
  }
  const owner = new JournalCheckpointOwner(writer, filename, {
    idleTeardownMs: 10,
    factory: makeFake
  })
  cleanup.push(() => owner.close())
  writer.prepare('INSERT INTO writes VALUES(?, zeroblob(1500000))').run(1)
  owner.afterCommit()
  await vi.waitFor(() => expect(fakes).toHaveLength(1))
  // The first worker catches up, goes idle, and is asked to stop, but its thread has not exited yet.
  await vi.waitFor(() => expect(fakes[0]!.stopped).toBe(true))
  writer.prepare('INSERT INTO writes VALUES(?, zeroblob(1500000))').run(2)
  owner.afterCommit()
  await vi.waitFor(() => expect(fakes).toHaveLength(2))
  let closed = false
  const closing = owner.close().then(() => {
    closed = true
  })
  await vi.waitFor(() => expect(fakes[1]!.stopped).toBe(true))
  fakes[1]!.exit()
  // Drain microtasks: a close that skipped the retiring worker would have resolved by now.
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve()
  }
  expect(closed).toBe(false)
  fakes[0]!.exit()
  await closing
  expect(closed).toBe(true)
})

it('lets saves past the WAL ceiling while a live worker stays inside one checkpoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'journal-checkpoint-stall-'))
  cleanup.push(() => rmSync(root, { recursive: true }))
  const filename = join(root, 'chat.db')
  const writer = new Database(filename)
  cleanup.push(() => writer.close())
  writer.exec(`PRAGMA page_size=512; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
    CREATE TABLE writes(id INTEGER PRIMARY KEY, body BLOB);`)
  // Alive but never answers, as a thread blocked in a native fsync; it exits only when stopped.
  const hung = Object.assign(new EventEmitter(), {
    postMessage: (message: { type: string }) => {
      if (message.type === 'stop') {
        queueMicrotask(() => hung.emit('exit', 0))
      }
    },
    unref: () => {},
    terminate: async () => 0
  })
  const owner = new JournalCheckpointOwner(writer, filename, { factory: () => hung, stallMs: 50 })
  cleanup.push(() => owner.close())
  const batch = new JournalSqlBatch(writer, owner)
  // A reader keeps the writer's own checkpoint from copying, so only the stall lets the save in.
  const reader = new Database(filename, { readonly: true })
  cleanup.push(() => reader.close())
  reader.exec('BEGIN; SELECT COUNT(*) FROM writes;')
  cleanup.push(() => reader.exec('COMMIT'))
  // Past the 32,768-frame bulk ceiling.
  await batch.run([1], (id) =>
    writer.prepare('INSERT INTO writes VALUES(?, zeroblob(18874368))').run(id)
  )
  await batch.run([2], (id) => writer.prepare("INSERT INTO writes VALUES(?, 'saved')").run(id))
  expect(writer.prepare('SELECT body FROM writes WHERE id = 2').get()).toEqual({ body: 'saved' })
})
