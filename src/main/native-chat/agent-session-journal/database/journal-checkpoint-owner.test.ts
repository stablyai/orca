import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../../sqlite/sync-database'
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
  const workers: { worker: Worker; ready: Promise<unknown> }[] = []
  const owner = new JournalCheckpointOwner(writer, filename, {
    restartDelayMs: 10,
    factory: () => {
      const worker = new Worker(journalCheckpointWorkerSource, {
        eval: true,
        workerData: { filename, frames: 1000, idleMs: 10 }
      })
      workers.push({ worker, ready: once(worker, 'message') })
      return worker
    }
  })
  cleanup.push(() => owner.close())
  await workers[0]!.ready
  await workers[0]!.worker.terminate()

  await vi.waitFor(() => expect(workers).toHaveLength(2))
  await workers[1]!.ready
  // ~3000 frames: past the worker's threshold, short of the writer's own autocheckpoint.
  writer.prepare('INSERT INTO writes VALUES(1, zeroblob(1500000))').run()
  owner.afterCommit()
  await vi.waitFor(() => {
    const state = writer.prepare('PRAGMA wal_checkpoint(NOOP)').get() as {
      log: number
      checkpointed: number
    }
    expect(state.log).toBeGreaterThan(1000)
    expect(state.checkpointed).toBe(state.log)
  })
})
