import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../../sqlite/sync-database'
import { JournalSqlBatch } from '../journal-sql-batch'
import { JournalCheckpointOwner } from './journal-checkpoint-owner'
import type { JournalCheckpointOutage } from './journal-checkpoint-outages'
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
    const ready = Promise.withResolvers<void>()
    const owner = new JournalCheckpointOwner(writer, filename, {
      factory: (workerData) => {
        const worker = new Worker(journalCheckpointWorkerSource, { eval: true, workerData })
        worker.on('message', (message) => {
          if (message.type === 'hello') {
            ready.resolve()
          }
          if (
            message.type === 'checked' &&
            message.blocked &&
            (pinAt === 'before-write' || message.truncateId !== undefined)
          ) {
            observedBlocked()
          }
        })
        return worker
      }
    })
    cleanup.push(() => owner.close())
    await ready.promise
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
  /** Answers the owner's startup hello, so it hands checkpoints over. */
  ready() {
    this.emit('message', { type: 'hello' })
  }
}

it('does not admit a send from a stale checkpoint, and close hands back admission before physical retirement', async () => {
  const { filename, writer } = fixture()
  const worker = new ControlledCheckpoint()
  writer.prepare('INSERT INTO writes VALUES(1, zeroblob(1048576))').run()
  const owner = new JournalCheckpointOwner(writer, filename, { factory: () => worker })
  worker.ready()
  const batch = new JournalSqlBatch(writer, owner)
  const old = worker.sent.at(-1)!
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
  worker.ready()
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

it('admits a sending chat past WAL pressure while bulk waits, but never past a truncate', async () => {
  const { filename, writer } = fixture()
  const worker = new ControlledCheckpoint()
  const owner = new JournalCheckpointOwner(writer, filename, { factory: () => worker })
  worker.ready()
  cleanup.push(() => {
    const closed = owner.close()
    worker.exited()
    return closed
  })
  const batch = new JournalSqlBatch(writer, owner)
  writer.prepare('INSERT INTO writes VALUES(1, zeroblob(18874368))').run()
  owner.afterCommit()
  const insert = (id: number) => writer.prepare(`INSERT INTO writes VALUES(?, 'w')`).run(id)
  const ids = () => writer.prepare('SELECT id FROM writes WHERE id > 1 ORDER BY id').all()

  let bulkAdmitted = false
  // The writer parks bulk outside its transaction, as its drain does, so a sending chat can pass.
  const bulk = owner.beforeWrite().then(() => {
    bulkAdmitted = true
  })
  await batch.run([3], insert, 'normal', true)
  expect(ids()).toEqual([{ id: 3 }])
  expect(bulkAdmitted).toBe(false)

  worker.emit('message', { type: 'truncate-request', truncateId: 7 })
  let sendingAdmitted = false
  const sending = batch.run(
    [4],
    (id) => {
      sendingAdmitted = true
      return insert(id)
    },
    'normal',
    true
  )
  for (let turn = 0; turn < 5; turn++) {
    await Promise.resolve()
  }
  expect(sendingAdmitted).toBe(false)

  worker.emit('message', {
    type: 'checked',
    truncateId: 7,
    generation: 0,
    log: 0,
    checkpointed: 0,
    blocked: false
  })
  await Promise.all([bulk, sending])
  expect(ids()).toEqual([{ id: 3 }, { id: 4 }])
})

// Two real worker threads start and the WAL drains after a restart backoff, beyond the default.
it('restarts a crashed checkpoint worker within the launch and shrinks the WAL it left behind', async () => {
  const { filename, writer } = fixture()
  const reader = new Database(filename, { readonly: true })
  cleanup.push(() => reader.close())
  const workers: Worker[] = []
  const outages: JournalCheckpointOutage[] = []
  let ready = 0
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const owner = new JournalCheckpointOwner(writer, filename, {
    restartBaseMs: 10,
    onOutage: (outage) => outages.push(outage),
    factory: (workerData) => {
      const worker = new Worker(journalCheckpointWorkerSource, { eval: true, workerData })
      worker.on('message', (message) => {
        if (message.type === 'hello') {
          ready++
        }
      })
      workers.push(worker)
      return worker
    }
  })
  cleanup.push(() => owner.close())
  const batch = new JournalSqlBatch(writer, owner)
  const walBytes = () => statSync(`${filename}-wal`).size
  await vi.waitFor(() => expect(ready).toBe(1))

  reader.exec('BEGIN; SELECT COUNT(*) FROM writes;')
  await workers[0]!.terminate()
  // The writer keeps committing while no worker runs; the pinned reader keeps the WAL from draining.
  await batch.run([1], (id) =>
    writer.prepare('INSERT INTO writes VALUES(?, zeroblob(18874368))').run(id)
  )
  expect(walBytes()).toBeGreaterThan(16 * 1024 * 1024)
  await vi.waitFor(() => expect(outages).toHaveLength(1), { timeout: 10_000 })
  expect(workers.at(-1)).not.toBe(workers[0])
  expect(outages[0]).toMatchObject({ cause: 'exited', recovered: true, restarts: 1 })
  expect(writer.pragma('wal_autocheckpoint', { simple: true })).toBe(0)

  reader.exec('ROLLBACK')
  await batch.run([2], (id) => writer.prepare("INSERT INTO writes VALUES(?, 'after')").run(id))
  await vi.waitFor(() => expect(walBytes()).toBeLessThan(1024 * 1024), { timeout: 10_000 })
  expect(writer.prepare('SELECT id FROM writes ORDER BY id').all()).toEqual([
    { id: 0 },
    { id: 1 },
    { id: 2 }
  ])
}, 20_000)

class LivenessCheckpoint extends ControlledCheckpoint {
  terminated = false
  constructor(readonly liveness: Int32Array) {
    super()
  }
  override terminate(): Promise<number> {
    this.terminated = true
    queueMicrotask(() => this.emit('exit', 1))
    return Promise.resolve(1)
  }
  /** The progress word is odd while the worker handles work. */
  busy(busy: boolean) {
    if ((Atomics.load(this.liveness, 0) % 2 === 1) !== busy) {
      Atomics.add(this.liveness, 0, 1)
    }
  }
  answer() {
    const request = this.sent.at(-1)!
    this.emit('message', {
      type: 'checked',
      id: request.id,
      generation: request.generation,
      log: 0,
      checkpointed: 0,
      blocked: false
    })
  }
}

it('keeps a late busy checkpoint worker, reports it once stuck, and replaces one that stays silent', async () => {
  const { filename, writer } = fixture()
  writer.pragma('wal_autocheckpoint = 1000')
  const workers: LivenessCheckpoint[] = []
  const outages: JournalCheckpointOutage[] = []
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const owner = new JournalCheckpointOwner(writer, filename, {
    timeoutMs: 20,
    stuckMs: 100,
    restartBaseMs: 10,
    onOutage: (outage) => outages.push(outage),
    factory: (workerData) => {
      const worker = new LivenessCheckpoint(new Int32Array(workerData.liveness))
      workers.push(worker)
      return worker
    }
  })
  cleanup.push(() => owner.close())
  const autocheckpoint = () => writer.pragma('wal_autocheckpoint', { simple: true })
  // The first worker owns checkpoints before it answers, so a crash's WAL isn't checkpointed on the writer.
  expect(autocheckpoint()).toBe(0)
  workers[0]!.busy(false)
  workers[0]!.ready()

  // Busy inside a checkpoint past the deadline: the writer takes checkpoints back, and the worker is
  // kept and reported once stuck.
  workers[0]!.busy(true)
  writer.prepare('INSERT INTO writes VALUES(1, zeroblob(1048576))').run()
  owner.afterCommit()
  await vi.waitFor(() => expect(autocheckpoint()).toBe(1000))
  await vi.waitFor(() => expect(warning).toHaveBeenCalled())
  expect(workers.at(-1)).toBe(workers[0])
  expect(workers[0]!.terminated).toBe(false)
  workers[0]!.busy(false)
  workers[0]!.answer()
  expect(autocheckpoint()).toBe(0)
  expect(outages).toEqual([
    expect.objectContaining({ cause: 'slow', recovered: true, restarts: 0 })
  ])

  // Its next check goes unanswered while it sits idle: dead after two silent deadlines, then replaced.
  await vi.waitFor(() => expect(workers.at(-1)).not.toBe(workers[0]))
  expect(workers[0]!.terminated).toBe(true)
  workers.at(-1)!.busy(false)
  workers.at(-1)!.ready()
  expect(autocheckpoint()).toBe(0)
  expect(outages[1]).toMatchObject({ cause: 'unresponsive', recovered: true, restarts: 1 })
})

it('hands checkpoints to the writer at the first deadline once writes are parked behind a busy worker', async () => {
  const { filename, writer } = fixture()
  let worker!: LivenessCheckpoint
  const owner = new JournalCheckpointOwner(writer, filename, {
    timeoutMs: 20,
    factory: (workerData) => {
      worker = new LivenessCheckpoint(new Int32Array(workerData.liveness))
      return worker
    }
  })
  cleanup.push(() => owner.close())
  worker.busy(false)
  worker.ready()
  // Past the bulk ceiling while the worker sits in a slow checkpoint, short of the 60 s stuck limit.
  writer.prepare('INSERT INTO writes VALUES(1, zeroblob(18874368))').run()
  worker.busy(true)
  owner.afterCommit()
  await new JournalSqlBatch(writer, owner).run([2], (id) =>
    writer.prepare("INSERT INTO writes VALUES(?, 'bulk')").run(id)
  )
  expect(writer.pragma('wal_autocheckpoint', { simple: true })).toBe(1000)
  expect(worker.terminated).toBe(false)
})
