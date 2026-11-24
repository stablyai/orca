import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  acquireChangedCheckSlot,
  formatAge,
  queueFileFor,
  readStartTimes
} from './check-changed-slot.mjs'

const WAITING = 'Waiting for another local check:changed run to finish…'
const moduleUrl = pathToFileURL(join(import.meta.dirname, 'check-changed-slot.mjs')).href

let root
let file
const cleanups = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-changed-slot-'))
  file = join(root, 'host.sqlite')
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
  await rm(root, { recursive: true, force: true })
})

function acquire(options = {}) {
  return acquireChangedCheckSlot(file, { pollMs: 5, log: () => {}, ancestors: [], ...options })
}

function track(promise) {
  const state = { done: false, release: undefined }
  state.promise = promise.then((release) => {
    state.done = true
    state.release = release
    cleanups.push(() => release())
    return release
  })
  return state
}

function queueRows() {
  const db = new DatabaseSync(queueFileFor(file))
  try {
    return db.prepare('SELECT * FROM tickets_v1 ORDER BY id').all()
  } finally {
    db.close()
  }
}

function insertTicket({ pid, started = null, seenAt = Date.now(), cwd = '/elsewhere' }) {
  const db = new DatabaseSync(queueFileFor(file))
  try {
    return Number(
      db
        .prepare(
          'INSERT INTO tickets_v1 (pid, started, cwd, enqueued_at, seen_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(pid, started, cwd, seenAt, seenAt).lastInsertRowid
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

it('drops the ticket of a waiter whose process is gone', async () => {
  const holder = await acquire()
  const deadPid = await exitedPid()
  const dead = insertTicket({ pid: deadPid })
  const waiter = track(acquire())
  holder()
  await waiter.promise
  expect(queueRows().map((row) => row.id)).not.toContain(dead)
}, 20_000)

it('drops a silent ticket whose pid now names a different process, but keeps a stopped waiter', async () => {
  const holder = await acquire()
  const started = readStartTimes([process.pid]).get(process.pid)
  expect(started).toBeTruthy()
  const long = Date.now() - 10 * 60_000
  const reused = insertTicket({ pid: process.pid, started: `${started} (earlier)`, seenAt: long })
  const stopped = insertTicket({ pid: process.pid, started, seenAt: long })
  const waiter = track(acquire({ staleMs: 1000 }))
  holder()
  await waiter.promise
  const ids = queueRows().map((row) => row.id)
  expect(ids).not.toContain(reused)
  // Its process is still the same one, so the ticket stays; it just no longer holds up the line.
  expect(ids).toContain(stopped)
}, 20_000)

it('lets the next waiter past a live waiter that stopped polling', async () => {
  ;(await acquire())()
  const started = readStartTimes([process.pid]).get(process.pid)
  const insertedAt = Date.now()
  insertTicket({ pid: process.pid, started, seenAt: insertedAt })
  const waiter = track(acquire({ staleMs: 3000 }))
  await delay(200)
  // Under heavy host load the delay can overrun the stale window; only assert when it did not.
  if (Date.now() - insertedAt < 2500) {
    expect(waiter.done).toBe(false)
  }
  await waiter.promise
  expect(Date.now() - insertedAt).toBeGreaterThanOrEqual(3000)
}, 20_000)

it('admits the next waiter when the holder process is killed, and names the holder while waiting', async () => {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { acquireChangedCheckSlot } = await import(${JSON.stringify(moduleUrl)})
await acquireChangedCheckSlot(${JSON.stringify(file)}, { pollMs: 5, ancestors: [], log: () => {} })
process.stdout.write('held\\n')
setInterval(() => {}, 1000)`
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] }
  )
  cleanups.push(() => child.kill('SIGKILL'))
  child.stdout.setEncoding('utf8')
  let output = ''
  for await (const chunk of child.stdout) {
    output += chunk
    if (output.includes('held')) {
      break
    }
  }
  const messages = []
  const waiter = track(acquire({ log: (message) => messages.push(message) }))
  await delay(150)
  expect(waiter.done).toBe(false)
  expect(messages).toHaveLength(1)
  expect(messages[0].startsWith(WAITING)).toBe(true)
  expect(messages[0]).toContain('Position 1 of 1.')
  expect(messages[0]).toContain(`pid ${child.pid} in ${await realpath(root)},`)

  child.kill('SIGKILL')
  await waiter.promise
  expect(queueRows().map((row) => row.pid)).toEqual([process.pid])
}, 20_000)

it('still excludes a holder that never joined the queue', async () => {
  const outsider = new DatabaseSync(file)
  outsider.exec('BEGIN IMMEDIATE')
  const messages = []
  const waiter = track(acquire({ log: (message) => messages.push(message) }))
  await delay(100)
  expect(waiter.done).toBe(false)
  expect(messages).toEqual([
    `${WAITING} Position 1 of 1. Running now: a run from a checkout without the queue.`
  ])
  outsider.close()
  await waiter.promise
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

it('formats holder ages', () => {
  expect(formatAge(12_000)).toBe('12s')
  expect(formatAge(5 * 60_000)).toBe('5m')
  expect(formatAge(125 * 60_000)).toBe('2h 5m')
})
