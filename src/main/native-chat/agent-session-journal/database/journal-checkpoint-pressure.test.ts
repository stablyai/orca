import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../../sqlite/sync-database'
import { JournalSqlBatch } from '../journal-sql-batch'
import { JournalCheckpointOwner, JOURNAL_WAL_BACKPRESSURE_FRAMES } from './journal-checkpoint-owner'
import { JOURNAL_SIZE_LIMIT_BYTES } from './journal-database'
import { journalCheckpointWorkerSource } from './journal-checkpoint-worker-source'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const step of cleanup.splice(0).toReversed()) {
    await step()
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'journal-wal-pressure-'))
  cleanup.push(() => rmSync(root, { recursive: true }))
  const filename = join(root, 'chat.db')
  const writer = new Database(filename)
  cleanup.push(() => writer.close())
  writer.exec(`PRAGMA page_size=512; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
    PRAGMA wal_autocheckpoint=0; CREATE TABLE writes(id INTEGER PRIMARY KEY, body BLOB);
    INSERT INTO writes VALUES(0, 'before');`)
  return { filename, writer }
}

it.each(['before-write', 'after-write'] as const)(
  'retains a queued send until a %s pinned reader releases, then truncates and admits it',
  async (pinAt) => {
    const { filename, writer } = fixture()
    const reader = new Database(filename, { readonly: true })
    cleanup.push(() => reader.close())
    let observedBlocked!: () => void
    const blocked = new Promise<void>((resolve) => {
      observedBlocked = resolve
    })
    const worker = new Worker(journalCheckpointWorkerSource, {
      eval: true,
      workerData: {
        filename,
        sizeLimit: JOURNAL_SIZE_LIMIT_BYTES,
        backpressureFrames: JOURNAL_WAL_BACKPRESSURE_FRAMES
      }
    })
    worker.on('message', (message) => {
      if (
        message.type === 'checked' &&
        message.blocked &&
        (pinAt === 'before-write' || message.truncateId !== undefined)
      ) {
        observedBlocked()
      }
    })
    const owner = new JournalCheckpointOwner(writer, filename, { factory: () => worker })
    cleanup.push(() => owner.close())
    const batch = new JournalSqlBatch(writer, owner)
    const pin = () => reader.exec('BEGIN; SELECT COUNT(*) FROM writes;')
    if (pinAt === 'before-write') {
      pin()
    }
    await batch.run([1], (id) =>
      writer.prepare('INSERT INTO writes VALUES(?, zeroblob(18874368))').run(id)
    )
    if (pinAt === 'after-write') {
      pin()
    }
    let admitted = false
    const send = batch.run([2], (id) => {
      admitted = true
      writer.prepare("INSERT INTO writes VALUES(?, 'queued send')").run(id)
    })
    await blocked
    expect(admitted).toBe(false)
    expect(writer.prepare('SELECT id FROM writes ORDER BY id').all()).toEqual([
      { id: 0 },
      { id: 1 }
    ])
    reader.exec('ROLLBACK')
    await send
    expect(writer.prepare('SELECT id, body FROM writes WHERE id=2').get()).toEqual({
      id: 2,
      body: 'queued send'
    })
    expect(Number(writer.prepare('PRAGMA wal_checkpoint(NOOP)').get()!.log)).toBeLessThan(32768)
    expect(statSync(`${filename}-wal`).size).toBeLessThan(JOURNAL_SIZE_LIMIT_BYTES)
  },
  15000
)

class ControlledCheckpoint extends EventEmitter {
  readonly sent: { type: string; id?: number; generation?: number }[] = []
  private finish: (() => void) | undefined
  unref() {
    return this
  }
  postMessage(message: { type: string; id?: number; generation?: number }) {
    this.sent.push(message)
  }
  terminate(): Promise<number> {
    return new Promise((resolve) => {
      this.finish = () => {
        this.emit('exit', 0)
        resolve(0)
      }
    })
  }
  exited() {
    this.finish!()
  }
}

it('does not admit a send from a stale checkpoint, and close hands back admission before physical retirement', async () => {
  const { filename, writer } = fixture()
  const worker = new ControlledCheckpoint()
  writer.prepare('INSERT INTO writes VALUES(1, zeroblob(1048576))').run()
  const owner = new JournalCheckpointOwner(writer, filename, { factory: () => worker })
  const batch = new JournalSqlBatch(writer, owner)
  const old = worker.sent[0]!
  writer.prepare('INSERT INTO writes VALUES(2, zeroblob(18874368))').run()
  owner.afterCommit()
  const send = batch.run([3], (id) =>
    writer.prepare("INSERT INTO writes VALUES(?, 'send')").run(id)
  )
  worker.emit('message', {
    type: 'checked',
    id: old.id,
    generation: old.generation,
    log: 0,
    checkpointed: 0,
    blocked: false
  })
  await Promise.resolve()
  expect(writer.prepare('SELECT id FROM writes WHERE id=3').get()).toBeUndefined()
  let retired = false
  const close = owner.close().then(() => {
    retired = true
  })
  cleanup.push(() => close)
  await send
  expect(writer.pragma('wal_autocheckpoint', { simple: true })).toBe(1000)
  expect(writer.prepare('SELECT body FROM writes WHERE id=3').get()).toEqual({ body: 'send' })
  expect(retired).toBe(false)
  worker.emit('message', { type: 'truncate-request', truncateId: 99 })
  worker.exited()
  await close
})

it('hands pending sends back to autocheckpoint when the checkpoint worker fails', async () => {
  const { filename, writer } = fixture()
  const worker = new ControlledCheckpoint()
  const owner = new JournalCheckpointOwner(writer, filename, { factory: () => worker })
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  writer.prepare('INSERT INTO writes VALUES(1, zeroblob(18874368))').run()
  owner.afterCommit()
  const send = new JournalSqlBatch(writer, owner).run([2], (id) =>
    writer.prepare("INSERT INTO writes VALUES(?, 'send')").run(id)
  )
  worker.emit('error', new Error('checkpoint unavailable'))
  await send
  expect(writer.pragma('wal_autocheckpoint', { simple: true })).toBe(1000)
  expect(writer.prepare('SELECT body FROM writes WHERE id=2').get()).toEqual({ body: 'send' })
  expect(warning).toHaveBeenCalled()
  const close = owner.close()
  worker.exited()
  await close
})
