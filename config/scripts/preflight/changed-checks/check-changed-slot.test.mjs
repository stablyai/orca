import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acquireChangedCheckSlot,
  formatAge,
  queueFileFor,
  readStartTimes
} from './check-changed-slot.mjs'

const WAITING = 'Waiting for another local check:changed run to finish…'
const UNLISTED = 'Running now: a run that is not in the queue, such as one from an older checkout.'
const moduleUrl = pathToFileURL(join(import.meta.dirname, 'check-changed-slot.mjs')).href

let root
let file
// Every pending acquisition, slot and child is registered when created and torn down after each
// test, even when an assertion fails first.
const owned = []

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-changed-slot-')))
  file = join(root, 'host.sqlite')
})

afterEach(async () => {
  for (const cleanup of owned.splice(0).toReversed()) {
    await cleanup()
  }
  await rm(root, { recursive: true, force: true })
})

function acquire(options = {}) {
  const controller = new AbortController()
  const promise = acquireChangedCheckSlot(file, {
    pollMs: 5,
    log: () => {},
    ancestors: [],
    signal: controller.signal,
    ...options
  })
  owned.push(async () => {
    controller.abort()
    const release = await promise.catch(() => undefined)
    release?.()
  })
  return promise
}

function observe(promise) {
  const state = { settled: false, error: undefined }
  state.promise = promise.then(
    (release) => {
      state.settled = true
      return release
    },
    (error) => {
      state.settled = true
      state.error = error
      throw error
    }
  )
  state.promise.catch(() => {})
  return state
}

function spawnOwned(body) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { acquireChangedCheckSlot } = await import(${JSON.stringify(moduleUrl)})
const { DatabaseSync } = await import('node:sqlite')
const { appendFileSync } = await import('node:fs')
const file = ${JSON.stringify(file)}
${body}`
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] }
  )
  const exited = once(child, 'exit')
  owned.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    await exited
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  return {
    child,
    exited,
    output: () => output,
    async waitFor(text) {
      while (!output.includes(text)) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`child exited before printing ${text}: ${output}`)
        }
        await delay(5)
      }
    },
    async kill() {
      child.kill('SIGKILL')
      await exited
    }
  }
}

function queueRows() {
  const db = new DatabaseSync(queueFileFor(file))
  try {
    return db.prepare('SELECT * FROM tickets_v1 ORDER BY id').all()
  } finally {
    db.close()
  }
}

function insertTicket({
  pid,
  started = null,
  seenAt = Date.now(),
  heldAt = null,
  cwd = '/elsewhere'
}) {
  const db = new DatabaseSync(queueFileFor(file))
  try {
    return Number(
      db
        .prepare(
          'INSERT INTO tickets_v1 (pid, started, cwd, enqueued_at, seen_at, held_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(pid, started, cwd, seenAt, seenAt, heldAt).lastInsertRowid
    )
  } finally {
    db.close()
  }
}

async function exitedPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await once(child, 'exit')
  return child.pid
}

async function createQueue() {
  ;(await acquire())()
}

// Production Windows runs check:changed concurrently and never loads the slot; these tests need POSIX ps or /proc.
describe.skipIf(process.platform === 'win32')('check:changed slot queue', () => {
  it('admits waiters one at a time in arrival order, whatever their poll rate', async () => {
    const holder = await acquire()
    const order = []
    let active = 1
    const waiters = Array.from({ length: 6 }, (_, index) =>
      // Earlier waiters poll slower, so retry timing alone would let later ones jump ahead.
      acquire({ pollMs: 60 - index * 10 }).then(async (release) => {
        active += 1
        expect(active).toBe(1)
        order.push(index)
        await delay(15)
        active -= 1
        release()
      })
    )
    await delay(80)
    expect(order).toEqual([])
    active -= 1
    holder()
    await Promise.all(waiters)
    expect(order).toEqual([0, 1, 2, 3, 4, 5])
    expect(queueRows()).toEqual([])
  }, 20_000)

  it('serves an earlier slow waiter before a stream of fast newcomers', async () => {
    const holder = await acquire()
    const order = []
    const slow = acquire({ pollMs: 100 }).then((release) => {
      order.push('slow')
      return release
    })
    const newcomers = [0, 1, 2].map((index) =>
      acquire({ pollMs: 1 }).then((release) => {
        order.push(`new${index}`)
        release()
      })
    )
    holder()
    const releaseSlow = await slow
    const late = acquire({ pollMs: 1 }).then((release) => {
      order.push('late')
      release()
    })
    await delay(30)
    expect(order).toEqual(['slow'])
    releaseSlow()
    await Promise.all([...newcomers, late])
    expect(order).toEqual(['slow', 'new0', 'new1', 'new2', 'late'])
  }, 20_000)

  it('keeps separate processes exclusive when they all start on a cold queue at once', async () => {
    const children = Array.from({ length: 4 }, () =>
      spawnOwned(`const release = await acquireChangedCheckSlot(file, { pollMs: 5, ancestors: [], log: () => {} })
const start = Date.now()
await new Promise((resolve) => setTimeout(resolve, 40))
const end = Date.now()
release()
process.stdout.write(JSON.stringify({ start, end }) + '\\n')`)
    )
    const codes = await Promise.all(children.map(async ({ exited }) => (await exited)[0]))
    expect(codes).toEqual([0, 0, 0, 0])
    const intervals = children
      .map(({ output }) => JSON.parse(output()))
      .sort((a, b) => a.start - b.start)
    for (let index = 1; index < intervals.length; index++) {
      expect(intervals[index].start).toBeGreaterThanOrEqual(intervals[index - 1].end)
    }
  }, 60_000)

  it('admits separate processes in the order they queued', async () => {
    const holder = await acquire()
    const orderFile = join(root, 'order.txt')
    const children = []
    for (const name of ['a', 'b', 'c']) {
      const child = spawnOwned(`const release = await acquireChangedCheckSlot(file, {
  pollMs: 5,
  ancestors: [],
  log: () => process.stdout.write('waiting\\n')
})
appendFileSync(${JSON.stringify(orderFile)}, ${JSON.stringify(name)} + '\\n')
await new Promise((resolve) => setTimeout(resolve, 20))
release()`)
      await child.waitFor('waiting')
      children.push(child)
    }
    holder()
    const codes = await Promise.all(children.map(async ({ exited }) => (await exited)[0]))
    expect(codes).toEqual([0, 0, 0])
    expect(await readFile(orderFile, 'utf8')).toBe('a\nb\nc\n')
  }, 60_000)

  it('drops the ticket of a waiter whose process is gone', async () => {
    const holder = await acquire()
    const dead = insertTicket({ pid: await exitedPid() })
    const waiter = acquire()
    holder()
    await waiter
    expect(queueRows().map((row) => row.id)).not.toContain(dead)
  }, 20_000)

  it('drops a silent ticket whose pid now names a different process, but keeps a stopped waiter', async () => {
    const holder = await acquire()
    const started = readStartTimes([process.pid]).get(process.pid)
    expect(started).toBeTruthy()
    const long = Date.now() - 10 * 60_000
    const reused = insertTicket({ pid: process.pid, started: `${started} (earlier)`, seenAt: long })
    const stopped = insertTicket({ pid: process.pid, started, seenAt: long })
    const waiter = acquire({ staleMs: 1000 })
    holder()
    await waiter
    const ids = queueRows().map((row) => row.id)
    expect(ids).not.toContain(reused)
    // Its process is still the same one, so the ticket stays; it just no longer holds up the line.
    expect(ids).toContain(stopped)
  }, 20_000)

  it('passes a live waiter only once it has been silent for staleMs', async () => {
    await createQueue()
    const staleMs = 1500
    const seenAt = Date.now()
    insertTicket({
      pid: process.pid,
      started: readStartTimes([process.pid]).get(process.pid),
      seenAt
    })
    await acquire({ staleMs })
    // held_at is stamped when the lock is taken, so a late-running test cannot hide an early admission.
    const held = queueRows().find((row) => row.held_at !== null)
    expect(held.held_at).toBeGreaterThan(seenAt + staleMs)
  }, 20_000)

  it('lets a fresh yielding waiter pass an earlier stopped waiter', async () => {
    const holder = await acquire()
    const stopped = insertTicket({
      pid: process.pid,
      started: readStartTimes([process.pid]).get(process.pid),
      seenAt: Date.now() - 10 * 60_000
    })
    const yielding = acquire({ ancestors: [await exitedPid()], staleMs: 60_000 })
    holder()
    await yielding
    expect(queueRows().map((row) => row.id)).toContain(stopped)
  }, 20_000)

  it('admits the next waiter when the holder process is killed, and names the holder while waiting', async () => {
    const holder =
      spawnOwned(`await acquireChangedCheckSlot(file, { pollMs: 5, ancestors: [], log: () => {} })
process.stdout.write('held\\n')
setInterval(() => {}, 1000)`)
    await holder.waitFor('held')
    const messages = []
    const waiter = observe(acquire({ log: (message) => messages.push(message) }))
    await delay(150)
    expect(waiter.settled).toBe(false)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatch(
      new RegExp(
        `^${WAITING} Position 1 of 1\\. Running now: pid ${holder.child.pid} in ${root.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}, started \\d+s ago\\.$`
      )
    )
    await holder.kill()
    await waiter.promise
    expect(queueRows().map((row) => row.pid)).toEqual([process.pid])
  }, 60_000)

  it('names a listed holder with its age when the message is printed', async () => {
    await createQueue()
    const outsider = new DatabaseSync(file)
    owned.push(() => outsider.isOpen && outsider.close())
    outsider.exec('BEGIN IMMEDIATE')
    insertTicket({ pid: process.pid, heldAt: Date.now() - 5 * 60_000 })
    const messages = []
    const waiter = observe(acquire({ log: (message) => messages.push(message) }))
    await delay(100)
    expect(messages).toEqual([
      `${WAITING} Position 1 of 1. Running now: pid ${process.pid} in /elsewhere, started 5m ago.`
    ])
    outsider.close()
    await waiter.promise
  }, 20_000)

  it('leaves the holder unnamed when no live, heartbeating ticket holds the slot', async () => {
    await createQueue()
    const outsider = new DatabaseSync(file)
    owned.push(() => outsider.isOpen && outsider.close())
    outsider.exec('BEGIN IMMEDIATE')
    // A former holder that is still alive but stopped heartbeating, and one whose pid is gone.
    insertTicket({ pid: await exitedPid(), heldAt: Date.now() })
    insertTicket({ pid: process.pid, heldAt: Date.now() - 60_000, seenAt: Date.now() - 60_000 })
    const messages = []
    const waiter = observe(acquire({ staleMs: 30_000, log: (message) => messages.push(message) }))
    await delay(100)
    expect(waiter.settled).toBe(false)
    expect(messages).toEqual([`${WAITING} Position 1 of 1. ${UNLISTED}`])
    outsider.close()
    await waiter.promise
    expect(queueRows().filter((row) => row.held_at !== null)).toHaveLength(1)
  }, 20_000)

  it('moves a waiter behind the line when its launcher has exited', async () => {
    const holder = await acquire()
    const order = []
    const messages = []
    const orphan = acquire({
      ancestors: [await exitedPid()],
      log: (message) => messages.push(message)
    }).then((release) => {
      order.push('orphan')
      release()
    })
    const launched = acquire().then((release) => {
      order.push('launched')
      release()
    })
    holder()
    await Promise.all([orphan, launched])
    expect(order).toEqual(['launched', 'orphan'])
    expect(messages[0]).toContain('has exited')
  }, 20_000)

  it('rejoins at the back when its ticket is dropped', async () => {
    const holder = await acquire()
    const order = []
    const first = acquire().then((release) => {
      order.push('first')
      release()
    })
    await delay(20)
    const firstTicket = queueRows().find((row) => row.held_at === null)
    const second = acquire().then((release) => {
      order.push('second')
      release()
    })
    const db = new DatabaseSync(queueFileFor(file))
    db.prepare('DELETE FROM tickets_v1 WHERE id = ?').run(firstTicket.id)
    db.close()
    await delay(20)
    holder()
    await Promise.all([first, second])
    expect(order).toEqual(['second', 'first'])
  }, 20_000)

  it('removes its ticket when acquisition fails, so the next call is not held up', async () => {
    const holder = await acquire()
    const failing = acquire({
      staleMs: 60_000,
      log: () => {
        throw new Error('log failed')
      }
    })
    await expect(failing).rejects.toThrow('log failed')
    expect(queueRows().filter((row) => row.held_at === null)).toEqual([])
    holder()
    // A leftover fresh ticket would block this call for the whole minute-long stale window.
    const startedAt = Date.now()
    await acquire({ staleMs: 60_000 })
    expect(Date.now() - startedAt).toBeLessThan(10_000)
  }, 20_000)

  it('keeps waiters pending while another process holds the queue database, then admits them in order', async () => {
    const holder = await acquire()
    const order = []
    const queued = observe(
      acquire().then((release) => {
        order.push('queued')
        return release
      })
    )
    await delay(30)
    const writer = spawnOwned(`const db = new DatabaseSync(${JSON.stringify(queueFileFor(file))})
db.exec('BEGIN IMMEDIATE')
process.stdout.write('locked\\n')
setInterval(() => {}, 1000)`)
    await writer.waitFor('locked')
    const arrival = observe(
      acquire().then((release) => {
        order.push('arrival')
        return release
      })
    )
    await delay(300)
    expect(queued.settled).toBe(false)
    expect(arrival.settled).toBe(false)

    // Reads still work under WAL, so the waiter already in line can take a free slot.
    holder()
    const releaseQueued = await queued.promise
    await delay(100)
    expect(arrival.settled).toBe(false)

    await writer.kill()
    await delay(100)
    expect(arrival.settled).toBe(false)
    releaseQueued()
    ;(await arrival.promise)()
    expect(order).toEqual(['queued', 'arrival'])
  }, 60_000)

  it('formats holder ages', () => {
    expect(formatAge(12_000)).toBe('12s')
    expect(formatAge(5 * 60_000)).toBe('5m')
    expect(formatAge(125 * 60_000)).toBe('2h 5m')
  })
})
