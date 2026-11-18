// Gate runs on one machine share ~/.cache/orca-fleet-gate; a lock keeps two runs from building the same entry at once.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const POLL_MS = 5_000
const WRITE_GRACE_MS = 60_000
const sleeper = new Int32Array(new SharedArrayBuffer(4))
const held = new Set()

/** pid plus its start time, so a reused pid never passes for the run that made a lock. */
function processIdentity(pid) {
  try {
    // LC_ALL=C: every run must print a given start time the same way.
    const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' }
    })
    return started.trim() ? `${String(pid)} ${started.trim()}` : null
  } catch {
    return null
  }
}

const ownIdentity = processIdentity(process.pid)
const TOMBSTONE_KEEP_MS = 24 * 60 * 60 * 1000

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

/**
 * Retires a dead owner's lock by renaming it to a tombstone named after that owner. The rename can succeed only once
 * per dead owner (later renames hit the existing, non-empty tombstone), so a run acting on a stale view can never
 * move a newer, live lock aside. Tombstones are pruned after a day.
 */
function clearStaleLock(lockDir, deadOwner) {
  const key = createHash('sha256')
    .update(
      deadOwner ?? `unwritten ${String(fs.statSync(lockDir, { throwIfNoEntry: false })?.mtimeMs)}`
    )
    .digest('hex')
    .slice(0, 16)
  const tombstone = `${lockDir}.dead-${key}`
  try {
    fs.renameSync(lockDir, tombstone)
    // Keep it non-empty: an empty directory can be renamed over.
    fs.writeFileSync(path.join(tombstone, 'retired'), deadOwner ?? 'unwritten')
  } catch {
    // Someone else retired it first, or the lock changed hands; just try again.
  }
  pruneTombstones(lockDir)
}

function pruneTombstones(lockDir) {
  const dir = path.dirname(lockDir)
  const prefix = `${path.basename(lockDir)}.dead-`
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (
      name.startsWith(prefix) &&
      Date.now() - (fs.statSync(full, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) >
        TOMBSTONE_KEEP_MS
    ) {
      fs.rmSync(full, { recursive: true, force: true })
    }
  }
}

function tryLock(lockDir) {
  if (!ownIdentity) {
    throw new Error(`can't read this process's start time with ps, so can't lock ${lockDir}`)
  }
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
