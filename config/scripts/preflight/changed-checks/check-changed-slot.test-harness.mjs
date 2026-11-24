import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, vi } from 'vitest'
import {
  acquireChangedCheckSlot,
  queueFileFor,
  settleChangedCheckSlotCleanup
} from './check-changed-slot.mjs'

// Shared by the check:changed slot tests: owned temp files, acquisitions, connections and children.
export const WAITING = 'Waiting for another local check:changed run to finish…'
export const UNNAMED =
  'The slot was held by a run the queue cannot name, such as one from an older checkout.'
/** How a line shows a holder: what the queue last recorded, never a claim about now. */
export const shownHolder = (pid) => `The queue last showed pid ${pid}`
const moduleUrl = pathToFileURL(join(import.meta.dirname, 'check-changed-slot.mjs')).href
// Longest wait for one piece of admitted work, a child or background cleanup to stop.
const DRAIN_MS = 30_000
// The whole teardown, every drain included, finishes inside this, well within the hook timeout.
const TEARDOWN_MS = 45_000
let teardownDeadline
// Set once teardown has drained everything; registering after that is reported, not missed.
let teardownClosed = false

export let root
export let file
let rawRoot
// Every acquisition, continuation, connection and child is registered when it is created.
const owned = []

function own(cleanup) {
  owned.push(cleanup)
}

/** Every helper checks this before it creates anything, so nothing is created unowned. */
function assertOpen() {
  if (teardownClosed) {
    throw new Error('a test resource was requested after teardown finished draining')
  }
}

/** Teardown could not confirm something stopped; the slot and temp root are kept, not torn down. */
class CustodyKept extends Error {}

/**
 * Registers the per-test temp root and the teardown. Teardown runs every owned cleanup, newest
 * first, including ones registered while it runs and despite earlier failures; then settles
 * background slot cleanup; then removes the root only if nothing was left in custody.
 */
export function registerSlotHarness() {
  beforeEach(async () => {
    teardownClosed = false
    teardownDeadline = undefined
    rawRoot = await mkdtemp(join(tmpdir(), 'orca-changed-slot-'))
    root = await realpath(rawRoot)
    file = join(root, 'host.sqlite')
  })

  afterEach(async () => {
    teardownDeadline = Date.now() + TEARDOWN_MS
    const errors = []
    // Owned cleanups and background slot cleanup can each start more of the other, so drain both
    // until a pass finds nothing new. Every wait, cleanups included, shares the one deadline.
    for (;;) {
      while (owned.length > 0) {
        const outcome = await bounded(owned.pop(), DRAIN_MS)
        if (!outcome.settled) {
          errors.push(new CustodyKept('a cleanup did not finish before the teardown deadline'))
        } else if (outcome.error) {
          errors.push(outcome.error)
        }
      }
      if (!(await settles(settleChangedCheckSlotCleanup(), DRAIN_MS))) {
        errors.push(new CustodyKept('background slot cleanup still running'))
        break
      }
      if (owned.length === 0) {
        break
      }
    }
    teardownClosed = true
    if (owned.length > 0) {
      // Registered too late to drain: reported and dropped, so they never reach the next test.
      errors.push(new CustodyKept(`${owned.length} cleanup(s) registered after draining stopped`))
      owned.length = 0
    }
    if (errors.some((error) => error instanceof CustodyKept)) {
      errors.push(new CustodyKept(`kept ${rawRoot} because something may still be using it`))
    } else {
      const removal = await bounded(() => rm(rawRoot, { recursive: true, force: true }), DRAIN_MS)
      if (!removal.settled || removal.error) {
        errors.push(removal.error ?? new CustodyKept(`could not remove ${rawRoot} in time`))
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'teardown failed')
    }
  })
}

/** Runs `fn` against the teardown deadline; reports whether it settled and how. */
async function bounded(fn, timeoutMs) {
  let error
  const work = Promise.resolve()
    .then(fn)
    .catch((caught) => {
      error = caught
    })
  const settled = await settles(work, timeoutMs)
  return { settled, error }
}

async function settles(promise, timeoutMs) {
  if (teardownDeadline !== undefined) {
    timeoutMs = Math.max(0, Math.min(timeoutMs, teardownDeadline - Date.now()))
  }
  const controller = new AbortController()
  const settled = await Promise.race([
    Promise.resolve(promise).then(
      () => true,
      () => true
    ),
    delay(timeoutMs, false, { signal: controller.signal }).catch(() => false)
  ])
  controller.abort()
  return settled
}

/**
 * Starts an acquisition and runs `onAcquired(release)` once it holds the slot. Teardown aborts a
 * pending acquisition; admitted work keeps the slot until it settles, and only then is the slot
 * released. If admitted work does not settle, the slot stays held and the root is kept.
 */
export function run(options = {}, onAcquired = (release) => release) {
  assertOpen()
  const controller = new AbortController()
  // A test's own signal is combined with, never substituted for, the harness's.
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal
  const acquisition = acquireChangedCheckSlot(file, {
    pollMs: 5,
    log: () => {},
    ancestors: [],
    ...options,
    signal
  })
  const continuation = acquisition.then(onAcquired)
  continuation.catch(() => {})
  own(async () => {
    controller.abort()
    const release = await acquisition.catch(() => undefined)
    if (!(await settles(continuation, DRAIN_MS))) {
      throw new CustodyKept('admitted work did not finish; its slot was kept')
    }
    await release?.()
  })
  continuation.abort = () => controller.abort()
  return continuation
}

export function observe(promise) {
  const state = { settled: false, error: undefined, promise }
  promise.then(
    () => {
      state.settled = true
    },
    (error) => {
      state.settled = true
      state.error = error
    }
  )
  return state
}

/** Pins only the first synchronous decision to the holder's heartbeat, independent of host stalls. */
export function runWithFreshHolder(options = {}) {
  const holder = queueRows().find((row) => row.held_at !== null)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Number(holder.seen_at))
  try {
    return run(options)
  } finally {
    clock.mockRestore()
  }
}

/** Helper deadline: its message names the condition, unlike the runner's test timeout. */
export async function until(condition, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`)
    }
    await delay(10)
  }
}

/** Helper deadline on a promise; the underlying work stays owned by whoever created it. */
export function within(promise, label, timeoutMs = 60_000) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
}

/** `program` exists so a test can exercise a spawn that fails. */
export function spawnOwned(body, { program = process.execPath } = {}) {
  assertOpen()
  const child = spawn(
    program,
    [
      '--input-type=module',
      '-e',
      `const { acquireChangedCheckSlot } = await import(${JSON.stringify(moduleUrl)})
const { DatabaseSync } = await import('node:sqlite')
const { appendFileSync } = await import('node:fs')
const { createInterface } = await import('node:readline')
const file = ${JSON.stringify(file)}
const queueFile = ${JSON.stringify(queueFileFor(file))}
const commands = createInterface({ input: process.stdin })[Symbol.asyncIterator]()
const next = async () => (await commands.next()).value
${body}`
    ],
    { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] }
  )
  const errors = []
  // A spawn failure arrives as 'error' before any 'spawn'; later errors are recorded separately.
  const started = new Promise((resolve) => {
    child.once('spawn', () => resolve(true))
    child.once('error', (error) => {
      errors.push(error)
      resolve(false)
    })
  })
  child.on('error', (error) => errors.includes(error) || errors.push(error))
  child.stdin.on('error', (error) => errors.push(error))
  child.stdout.on('error', (error) => errors.push(error))
  // 'close' comes after exit once stdout and stderr have closed.
  const closed = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  // Errors seen before our own kill are never excused by it.
  let errorsBeforeKill
  own(async () => {
    if (!(await started)) {
      // A failed spawn has no process; its pipes may still report 'close', but need not.
      await settles(closed, 1000)
      throw new AggregateError(errors, `child failed to start`)
    }
    if (child.exitCode === null && child.signalCode === null) {
      try {
        errorsBeforeKill ??= errors.length
        child.kill('SIGKILL')
      } catch (error) {
        throw new CustodyKept(`child ${child.pid} could not be killed: ${error.message}`)
      }
    }
    if (!(await settles(closed, DRAIN_MS))) {
      throw new CustodyKept(`child ${child.pid} did not close`)
    }
    // A pipe broken by our own kill is expected; anything else the child's pipes reported is not.
    const unexpected = errors.filter(
      (error, index) =>
        errorsBeforeKill === undefined ||
        index < errorsBeforeKill ||
        !['EPIPE', 'ERR_STREAM_DESTROYED'].includes(error.code)
    )
    if (unexpected.length > 0) {
      throw new AggregateError(unexpected, `child ${child.pid} reported errors`)
    }
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  return {
    pid: child.pid,
    closed,
    errors,
    output: () => output,
    send(command) {
      // A write the pipe refuses is reported through its callback, not always as an 'error' event.
      child.stdin.write(`${command}\n`, (error) => {
        if (error && !errors.includes(error)) {
          errors.push(error)
        }
      })
    },
    async waitFor(text) {
      if (!(await started)) {
        throw new Error(`child failed to start: ${errors[0]?.message}`)
      }
      return until(() => {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`child exited before printing ${text}: ${output}`)
        }
        return output.includes(text)
      }, `child output ${text}`)
    },
    async kill() {
      errorsBeforeKill ??= errors.length
      child.kill('SIGKILL')
      await closed
    }
  }
}

export function openQueue() {
  assertOpen()
  const db = new DatabaseSync(queueFileFor(file))
  own(() => db.isOpen && db.close())
  return db
}

export function queueRows() {
  const db = new DatabaseSync(queueFileFor(file))
  try {
    return db.prepare('SELECT * FROM tickets_v4 ORDER BY id').all()
  } finally {
    db.close()
  }
}

export function insertTicket({
  id = null,
  pid,
  seenAt = Date.now(),
  heldAt = null,
  lane = 0,
  cwd = '/elsewhere'
}) {
  const db = new DatabaseSync(queueFileFor(file))
  try {
    return Number(
      db
        .prepare(
          'INSERT INTO tickets_v4 (id, token, pid, cwd, enqueued_at, seen_at, lane, held_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(id, randomUUID(), pid, cwd, seenAt, seenAt, lane, heldAt).lastInsertRowid
    )
  } finally {
    db.close()
  }
}

/** Keeps a ticket checking in, like a live waiter that never reaches the front, until teardown. */
export function keepCheckingIn(id) {
  assertOpen()
  const db = new DatabaseSync(queueFileFor(file), { timeout: 100 })
  const timer = setInterval(() => {
    try {
      db.prepare('UPDATE tickets_v4 SET seen_at = ? WHERE id = ?').run(Date.now(), id)
    } catch {
      // Busy: the next beat retries.
    }
  }, 100)
  own(() => {
    clearInterval(timer)
    db.close()
  })
}

/** A raw connection on the slot file, like a run from a checkout without the queue. */
export function outsider() {
  assertOpen()
  const db = new DatabaseSync(file)
  own(() => db.isOpen && db.close())
  return {
    tryLock() {
      try {
        db.exec('BEGIN IMMEDIATE')
        return true
      } catch (error) {
        if (error.errcode !== 5) {
          throw error
        }
        return false
      }
    },
    close: () => db.close()
  }
}

/** A child process that holds the queue database's write lock until it is killed. */
export async function queueWriter() {
  const writer = spawnOwned(`const db = new DatabaseSync(queueFile, { timeout: 10_000 })
db.exec('BEGIN IMMEDIATE')
process.stdout.write('locked\\n')
await next()`)
  await writer.waitFor('locked')
  return writer
}

/** The pid of a process that has already exited. */
export async function exitedPid() {
  const child = spawnOwned('process.exit(0)')
  await child.closed
  return child.pid
}

export async function createQueue() {
  await (
    await run()
  )()
}
