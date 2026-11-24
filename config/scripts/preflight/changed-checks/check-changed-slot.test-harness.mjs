import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach } from 'vitest'
import {
  acquireChangedCheckSlot,
  queueFileFor,
  readStartTimes,
  settleChangedCheckSlotCleanup
} from './check-changed-slot.mjs'

// Shared by the check:changed slot tests: owned temp files, acquisitions, connections and children.
export const WAITING = 'Waiting for another local check:changed run to finish…'
export const UNNAMED =
  'Running now: a run the queue cannot name, such as one from an older checkout.'
const moduleUrl = pathToFileURL(join(import.meta.dirname, 'check-changed-slot.mjs')).href

export let root
export let file
// Every acquisition, continuation, connection and child is registered when it is created. Teardown
// runs all of them even if one throws, settles background cleanup, then removes the files.
const owned = []

function own(cleanup) {
  owned.push(cleanup)
}

/** Registers the per-test temp directory and the teardown that drains everything `own` recorded. */
export function registerSlotHarness() {
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-changed-slot-')))
    file = join(root, 'host.sqlite')
  })

  afterEach(async () => {
    const errors = []
    for (const cleanup of owned.splice(0).toReversed()) {
      try {
        await cleanup()
      } catch (error) {
        errors.push(error)
      }
    }
    await settleChangedCheckSlotCleanup()
    await rm(root, { recursive: true, force: true })
    if (errors.length > 0) {
      throw new AggregateError(errors, 'teardown failed')
    }
  })
}

/**
 * Starts an acquisition and runs `onAcquired(release)` once it holds the slot. The returned promise
 * is owned: teardown aborts a pending acquisition, releases a held slot, and awaits both.
 */
export function run(options = {}, onAcquired = (release) => release) {
  const controller = new AbortController()
  let continuation
  own(() => continuation?.catch(() => {}))
  const acquisition = acquireChangedCheckSlot(file, {
    pollMs: 5,
    log: () => {},
    ancestors: [],
    signal: controller.signal,
    ...options
  })
  own(async () => {
    controller.abort()
    const release = await acquisition.catch(() => undefined)
    await release?.()
  })
  continuation = acquisition.then(onAcquired)
  continuation.catch(() => {})
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

export async function until(condition, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`)
    }
    await delay(10)
  }
}

export function within(promise, label, timeoutMs = 30_000) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
}

export function spawnOwned(body) {
  const child = spawn(
    process.execPath,
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
  // 'close' follows exit once stdout has drained; a failed spawn settles it through 'error'.
  const closed = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }))
    child.once('error', (error) => resolve({ code: null, signal: null, error }))
  })
  own(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    await closed
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  return {
    pid: child.pid,
    closed,
    output: () => output,
    send(command) {
      child.stdin.write(`${command}\n`)
    },
    waitFor(text) {
      return until(() => {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`child exited before printing ${text}: ${output}`)
        }
        return output.includes(text)
      }, `child output ${text}`)
    },
    async kill() {
      child.kill('SIGKILL')
      await closed
    }
  }
}

export function openQueue() {
  const db = new DatabaseSync(queueFileFor(file))
  own(() => db.isOpen && db.close())
  return db
}

export function queueRows() {
  const db = new DatabaseSync(queueFileFor(file))
  try {
    return db.prepare('SELECT * FROM tickets_v2 ORDER BY id').all()
  } finally {
    db.close()
  }
}

export function insertTicket({
  id = null,
  pid,
  started = null,
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
          'INSERT INTO tickets_v2 (id, pid, started, cwd, enqueued_at, seen_at, lane, held_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(id, pid, started, cwd, seenAt, seenAt, lane, heldAt).lastInsertRowid
    )
  } finally {
    db.close()
  }
}

/** A raw connection on the slot file, like a run from a checkout without the queue. */
export function outsider() {
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
  const writer = spawnOwned(`const db = new DatabaseSync(queueFile)
db.exec('BEGIN IMMEDIATE')
process.stdout.write('locked\\n')
await next()`)
  await writer.waitFor('locked')
  return writer
}

export async function exitedPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await once(child, 'close')
  return child.pid
}

export async function createQueue() {
  await (
    await run()
  )()
}

export const ownStart = () => readStartTimes([process.pid]).get(process.pid)
