import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import * as timers from 'node:timers'
import { afterEach, expect, it, vi } from 'vitest'
import { JournalHostDatabase } from './journal-host-database'
import type * as WorkerSource from './journal-checkpoint-worker-source'

const deadlines = vi.hoisted(() => ({
  active: new Set<ReturnType<typeof globalThis.setTimeout>>(),
  maximum: 0
}))
vi.mock('node:timers', () => ({
  setTimeout: vi.fn((run: () => void, ms?: number) => {
    const timer = globalThis.setTimeout(() => {
      deadlines.active.delete(timer)
      run()
    }, ms)
    deadlines.active.add(timer)
    deadlines.maximum = Math.max(deadlines.maximum, deadlines.active.size)
    return timer
  }),
  clearTimeout: (timer: ReturnType<typeof globalThis.setTimeout> | undefined) => {
    if (timer !== undefined) {
      deadlines.active.delete(timer)
    }
    globalThis.clearTimeout(timer)
  }
}))

// Instrument the evaluated production worker at its native I/O boundaries.
vi.mock('./journal-checkpoint-worker-source', async (original) => {
  const source = await original<typeof WorkerSource>()
  return {
    journalCheckpointWorkerSource: `
const metrics = { noop: 0, passive: 0, stat: 0, timers: 0, maxTimers: 0 };
const activeTimers = new Set();
const nativeSetTimeout = setTimeout;
const nativeClearTimeout = clearTimeout;
global.setTimeout = (run, ms) => {
  metrics.timers++;
  const timer = nativeSetTimeout(() => { activeTimers.delete(timer); run(); }, ms);
  activeTimers.add(timer);
  metrics.maxTimers = Math.max(metrics.maxTimers, activeTimers.size);
  return timer;
};
global.clearTimeout = (timer) => { activeTimers.delete(timer); nativeClearTimeout(timer); };
const sqlite = require('node:sqlite');
const nativePrepare = sqlite.DatabaseSync.prototype.prepare;
sqlite.DatabaseSync.prototype.prepare = function(sql) {
  const statement = nativePrepare.call(this, sql);
  const nativeGet = statement.get;
  statement.get = function(...args) {
    if (sql === 'PRAGMA wal_checkpoint(NOOP)') metrics.noop++;
    if (sql === 'PRAGMA wal_checkpoint(PASSIVE)') metrics.passive++;
    return nativeGet.apply(this, args);
  };
  return statement;
};
const fs = require('node:fs');
const nativeStat = fs.statSync;
fs.statSync = (...args) => { metrics.stat++; return nativeStat(...args); };
const port = require('node:worker_threads').parentPort;
const nativePost = port.postMessage.bind(port);
port.postMessage = (message) => nativePost({ ...message, metrics: { ...metrics } });
${source.journalCheckpointWorkerSource}`
  }
})

type Metrics = { noop: number; passive: number; stat: number; timers: number; maxTimers: number }
type Checked = { type: 'checked'; id?: number; log: number; checkpointed: number; metrics: Metrics }
let host: JournalHostDatabase | undefined
let root: string

afterEach(async () => {
  vi.restoreAllMocks()
  await host?.close()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture(history: number) {
  const reports: Checked[] = []
  let sent = 0
  let outstanding = 0
  let maximum = 0
  const post = Worker.prototype.postMessage
  vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, message) {
    if (message?.type === 'check') {
      if (sent === 0) {
        this.prependListener('message', (report: Checked) => {
          if (report.type !== 'checked') {
            return
          }
          reports.push(report)
          if (report.id !== undefined) {
            outstanding--
          }
        })
      }
      sent++
      outstanding++
      maximum = Math.max(maximum, outstanding)
    }
    return post.call(this, message)
  })
  const deadline = vi.spyOn(timers, 'setTimeout')
  root = await mkdtemp(join(tmpdir(), 'orca-checkpoint-scaling-'))
  const database = JournalHostDatabase.open(root)
  host = database
  database.transaction((db) => {
    db.exec('CREATE TABLE maintenance_corpus (chat INTEGER, payload BLOB)')
    const insert = db.prepare('INSERT INTO maintenance_corpus VALUES (?, zeroblob(100))')
    for (let i = 0; i < history; i++) {
      insert.run(i)
    }
  })
  async function settled() {
    await vi.waitFor(
      () => {
        expect(outstanding).toBe(0)
        const last = reports.at(-1)
        expect(last).toBeDefined()
        expect(last?.log).toBe(last?.checkpointed)
      },
      { timeout: 3000 }
    )
    return reports.at(-1)!.metrics
  }
  await settled()
  expect(deadlines.active.size).toBe(0)
  deadlines.maximum = 0
  return {
    database,
    reports,
    deadline,
    settled,
    counts: () => ({ sent, outstanding, maximum })
  }
}

const schedules = ['burst', 'settled'].flatMap((schedule) =>
  [10, 1000].flatMap((history) =>
    [10, 100].map((population) => ({ schedule, history, population }))
  )
)
it.each(schedules)(
  'bounds $schedule maintenance for $population chats and $history retained rows',
  async ({ schedule, history, population }) => {
    const { database, reports, deadline, settled, counts } = await fixture(history)
    const before = counts().sent
    const initial = reports.at(-1)!.metrics
    const deadlineCount = deadline.mock.calls.length
    const prepare = vi.spyOn(database.db, 'prepare')
    const exec = vi.spyOn(database.db, 'exec')
    const pragma = vi.spyOn(database.db, 'pragma')
    for (let chat = 0; chat < population; chat++) {
      database.transaction((db) =>
        db.prepare('INSERT INTO maintenance_corpus VALUES (?, zeroblob(100))').run(chat)
      )
      if (schedule === 'settled') {
        await vi.waitFor(() => expect(counts().outstanding).toBe(0), { interval: 1 })
      }
    }
    const final = await settled()
    const requests = counts().sent - before
    expect(requests).toBe(schedule === 'burst' ? 2 : population)
    expect(counts().maximum).toBe(1)
    expect(deadline.mock.calls.length - deadlineCount).toBe(requests)
    expect(deadlines.maximum).toBe(1)
    expect(deadlines.active.size).toBe(0)
    expect(prepare).toHaveBeenCalledTimes(population)
    expect(exec).toHaveBeenCalledTimes(2 * population)
    expect(pragma).not.toHaveBeenCalled()
    const checks = final.stat - initial.stat
    expect(checks).toBeGreaterThanOrEqual(requests)
    expect(checks).toBeLessThanOrEqual(requests + 1)
    expect(final.noop - initial.noop).toBeLessThanOrEqual(2 * checks)
    expect(final.passive - initial.passive).toBeLessThanOrEqual(checks)
    expect(final.timers - initial.timers).toBeLessThanOrEqual(checks)
    expect(final.maxTimers).toBe(1)
    expect(database.db.prepare('SELECT count(*) AS n FROM maintenance_corpus').get()?.n).toBe(
      history + population
    )
  }
)

it.each([10, 100])(
  'keeps %i fallback commits durable without new worker requests or deadlines',
  async (population) => {
    const { database, deadline, counts } = await fixture(10)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(Worker.prototype, 'postMessage').mockImplementationOnce(() => {
      throw new Error('send failed')
    })
    database.transaction((db) =>
      db.exec('INSERT INTO maintenance_corpus VALUES (-1, zeroblob(100))')
    )
    const requests = counts().sent
    const deadlines = deadline.mock.calls.length
    for (let chat = 0; chat < population; chat++) {
      database.transaction((db) =>
        db.prepare('INSERT INTO maintenance_corpus VALUES (?, zeroblob(100))').run(chat)
      )
    }
    expect(counts().sent).toBe(requests)
    expect(deadline.mock.calls.length).toBe(deadlines)
    expect(database.db.pragma('wal_autocheckpoint', { simple: true })).toBe(1000)
    expect(database.db.prepare('SELECT count(*) AS n FROM maintenance_corpus').get()?.n).toBe(
      11 + population
    )
  }
)
