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
  // ~3000 frames each: past the worker's threshold, short of the writer's own autocheckpoint.
  const checkpointedBy = async (id: number) => {
    writer.prepare('INSERT INTO writes VALUES(?, zeroblob(1500000))').run(id)
    owner.afterCommit()
    await vi.waitFor(() => {
      const state = writer.prepare('PRAGMA wal_checkpoint(NOOP)').get() as {
        log: number
        checkpointed: number
      }
      expect(state.log).toBeGreaterThan(1000)
      expect(state.checkpointed).toBe(state.log)
    })
  }
  await checkpointedBy(1)
  await workers[0]!.terminate()

  await vi.waitFor(() => expect(workers).toHaveLength(2))
  await checkpointedBy(2)
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
