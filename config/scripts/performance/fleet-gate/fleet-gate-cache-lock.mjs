// Gate runs on one machine share ~/.cache/orca-fleet-gate; a lock keeps two runs from building the same entry at once.
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const POLL_MS = 5_000
const sleeper = new Int32Array(new SharedArrayBuffer(4))
const held = new Set()

/**
 * pid plus its start time, so a reused pid never passes for the run that recorded it: 'alive' with that identity,
 * 'gone' when ps ran and found no such process, 'unknown' when ps itself failed (a busy host is no proof of death).
 */
export function probeProcess(pid) {
  // LC_ALL and TZ: every process must print a given start time the same way.
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }
  })
  const started = typeof r.stdout === 'string' ? r.stdout.trim() : ''
  if (r.error || r.signal) {
    return { state: 'unknown' }
  }
  if (r.status === 0 && started) {
    return { state: 'alive', identity: `${String(pid)} ${started}` }
  }
  return r.status === 1 && !started ? { state: 'gone' } : { state: 'unknown' }
}

export function processIdentity(pid) {
  const probe = probeProcess(pid)
  return probe.state === 'alive' ? probe.identity : null
}

/** 'alive', 'dead' (gone or a different process now) or 'unknown' for a recorded identity. */
export function identityState(identity) {
  const pid = Number(String(identity).split(' ')[0])
  if (!Number.isInteger(pid) || pid <= 1) {
    return 'dead'
  }
  const probe = probeProcess(pid)
  if (probe.state === 'unknown') {
    return 'unknown'
  }
  return probe.state === 'alive' && probe.identity === identity ? 'alive' : 'dead'
}

const ownIdentity = processIdentity(process.pid)

function readOwner(lockDir) {
  try {
    return fs.readFileSync(path.join(lockDir, 'owner'), 'utf8') || null
  } catch {
    return null
  }
}

/**
 * Takes the lock or reports who holds it. A lock is published with its owner already inside (rename is atomic), and
 * a dead owner's lock is never taken over automatically: every takeover scheme races with a third run, so the run
 * stops and says which lock to remove.
 */
function tryLock(entryDir) {
  const lockDir = `${entryDir}.lock`
  if (!ownIdentity) {
    throw new Error(`can't read this process's start time with ps, so can't lock ${lockDir}`)
  }
  const staging = `${lockDir}.new-${String(process.pid)}-${randomUUID()}`
  fs.mkdirSync(staging)
  fs.writeFileSync(path.join(staging, 'owner'), ownIdentity)
  try {
    fs.renameSync(staging, lockDir)
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) {
      throw error
    }
    const owner = readOwner(lockDir)
    if (owner === null && !fs.existsSync(lockDir)) {
      // Released between our rename and this read: just try again.
      return null
    }
    const state = owner === null ? 'dead' : identityState(owner)
    if (state === 'unknown') {
      // ps failed: try again on the next poll rather than calling a live owner dead.
      return null
    }
    if (state === 'dead') {
      throw new Error(
        `stale cache lock ${lockDir} (owner ${owner ?? 'unknown'} is no longer running). ` +
          `If no gate run is using ${entryDir}, remove it: rm -rf '${lockDir}' '${entryDir}'`
      )
    }
    return null
  }
  const release = () => {
    held.delete(release)
    if (readOwner(lockDir) === ownIdentity) {
      // Moved aside first, so the path never holds a half-deleted lock.
      const aside = `${lockDir}.released-${String(process.pid)}-${randomUUID()}`
      fs.renameSync(lockDir, aside)
      fs.rmSync(aside, { recursive: true, force: true })
    }
  }
  held.add(release)
  return release
}

function announce(entryDir, state) {
  if (!state.announced) {
    console.log(`[fleet-gate] waiting for another gate run to finish ${entryDir}`)
    state.announced = true
  }
}

/** Takes `<entry>.lock`, waiting while a live run holds it. Blocks the event loop: call it before signal handlers matter. */
export function lockCacheEntry(entryDir) {
  const state = { announced: false }
  for (;;) {
    const release = tryLock(entryDir)
    if (release) {
      return release
    }
    announce(entryDir, state)
    Atomics.wait(sleeper, 0, 0, POLL_MS)
  }
}

/** The same lock, waited for without blocking, so a stop signal still runs its handler. */
export async function lockCacheEntryAsync(entryDir) {
  const state = { announced: false }
  for (;;) {
    const release = tryLock(entryDir)
    if (release) {
      return release
    }
    announce(entryDir, state)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

/** Takes the lock only if it is free right now; never waits and never throws (a stale lock just means "skip"). */
export function tryLockCacheEntry(entryDir) {
  try {
    return tryLock(entryDir)
  } catch {
    return null
  }
}

/** For a stopping gate: process.exit skips the finally blocks that would release these. */
export function releaseHeldLocks() {
  for (const release of held) {
    release()
  }
}
