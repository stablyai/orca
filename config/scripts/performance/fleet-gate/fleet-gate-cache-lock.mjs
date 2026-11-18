// Gate runs on one machine share ~/.cache/orca-fleet-gate; a lock keeps two runs from building the same entry at once.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const POLL_MS = 5_000
const WRITE_GRACE_MS = 60_000
const sleeper = new Int32Array(new SharedArrayBuffer(4))
const held = new Set()

/** pid plus its start time, so a reused pid never passes for the run that made a lock. */
function processIdentity(pid) {
  try {
    const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' })
    return started.trim() ? `${String(pid)} ${started.trim()}` : null
  } catch {
    return null
  }
}

const ownIdentity = processIdentity(process.pid) ?? `${String(process.pid)} unknown`

function readOwner(lockDir) {
  try {
    return fs.readFileSync(`${lockDir}/owner`, 'utf8')
  } catch {
    return null
  }
}

function ownerAlive(lockDir) {
  const owner = readOwner(lockDir)
  if (owner === null) {
    // The owner made the lock but hasn't written it yet, unless it died in between long ago.
    return (
      Date.now() - (fs.statSync(lockDir, { throwIfNoEntry: false })?.mtimeMs ?? 0) < WRITE_GRACE_MS
    )
  }
  return processIdentity(Number(owner.split(' ')[0])) === owner
}

/** Moves a dead owner's lock aside; only the run whose rename succeeds, and finds that same owner, takes it over. */
function clearStaleLock(lockDir, deadOwner) {
  const aside = `${lockDir}.stale-${String(process.pid)}-${String(Date.now())}`
  try {
    fs.renameSync(lockDir, aside)
  } catch {
    return
  }
  if (readOwner(aside) !== deadOwner) {
    // Another run replaced the stale lock first; put its live lock back.
    try {
      fs.renameSync(aside, lockDir)
      return
    } catch {
      // A third run took the path meanwhile; that run's lock stands.
    }
  }
  fs.rmSync(aside, { recursive: true, force: true })
}

function tryLock(lockDir) {
  try {
    fs.mkdirSync(lockDir)
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error
    }
    const owner = readOwner(lockDir)
    if (!ownerAlive(lockDir)) {
      clearStaleLock(lockDir, owner)
    }
    return null
  }
  fs.writeFileSync(`${lockDir}/owner`, ownIdentity)
  const release = () => {
    held.delete(release)
    if (readOwner(lockDir) === ownIdentity) {
      fs.rmSync(lockDir, { recursive: true, force: true })
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
    const release = tryLock(`${entryDir}.lock`)
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
    const release = tryLock(`${entryDir}.lock`)
    if (release) {
      return release
    }
    announce(entryDir, state)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

/** For a stopping gate: process.exit skips the finally blocks that would release these. */
export function releaseHeldLocks() {
  for (const release of held) {
    release()
  }
}
