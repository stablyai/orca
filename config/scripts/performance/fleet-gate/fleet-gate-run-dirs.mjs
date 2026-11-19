// A copy's terminal daemon detaches into its own session, so a killed gate (SIGKILL, a timeout, a lost host) would leave
// it running forever. Each run folder therefore records its owner and every copy it launched, and the next gate reaps
// folders whose owner is gone; a live gate also kills its copies synchronously on any exit.
import fs from 'node:fs'
import path from 'node:path'
import { CACHE_ROOT } from './fleet-gate-builds.mjs'
import { processIdentity } from './fleet-gate-cache-lock.mjs'
import { descendantPids, readDaemonPids, stopCopyDaemons } from './fleet-gate-copies.mjs'

export const RUNS_ROOT = path.join(CACHE_ROOT, 'runs')
// A folder with no owner yet is one being created right now, unless it is this old.
const UNOWNED_GRACE_MS = 10 * 60_000
const liveCopies = new Map()

/** A fresh folder under the gate's cache, owned by this process; copies get their TMPDIR inside it. */
export function createRunDir(prefix, root = RUNS_ROOT) {
  const owner = processIdentity(process.pid)
  if (!owner) {
    throw new Error("can't read this process's start time with ps, so can't own a run folder")
  }
  fs.mkdirSync(root, { recursive: true })
  const dir = fs.mkdtempSync(path.join(root, `${prefix}-`))
  fs.writeFileSync(path.join(dir, 'owner'), owner)
  fs.mkdirSync(path.join(dir, 'apps'))
  return dir
}

function ownerFolder(dir) {
  // A copy's run folder sits inside the gate's run folder (runs/<gate>/<arm>-<n>) or is one (a seed).
  for (let at = dir; at !== path.dirname(at); at = path.dirname(at)) {
    if (fs.existsSync(path.join(at, 'owner'))) {
      return at
    }
  }
  return null
}

/** Records a launched copy so a later gate can reap it; returns the call that forgets it after a clean close. */
export function registerCopy(runDir, pid, userDataDir) {
  const identity = processIdentity(pid)
  const owner = ownerFolder(runDir)
  if (!identity || !owner) {
    return () => {}
  }
  const record = path.join(owner, 'apps', String(pid))
  fs.writeFileSync(record, JSON.stringify({ identity, userDataDir }))
  liveCopies.set(pid, { identity, userDataDir })
  return () => {
    liveCopies.delete(pid)
    fs.rmSync(record, { force: true })
  }
}

function killAppGroup(pid, identity, signal) {
  if (processIdentity(pid) !== identity) {
    return
  }
  // Playwright starts the app in its own process group: this reaches its renderer, GPU and utility processes too.
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // Already gone.
    }
  }
}

/** For process 'exit': synchronous, so it runs on a thrown error or process.exit as well. */
export function killLiveCopiesNow() {
  for (const [pid, { identity, userDataDir }] of liveCopies) {
    killAppGroup(pid, identity, 'SIGKILL')
    // readDaemonPids proves each daemon is this copy's (launch nonce, pid record, start time) just before the kill.
    for (const root of readDaemonPids(userDataDir)) {
      for (const daemonPid of [...descendantPids(root), root]) {
        try {
          process.kill(daemonPid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }
  }
  liveCopies.clear()
}

/** Stops what dead gates left behind (verified copies and daemons only), then deletes their folders. */
export async function reapStaleRunDirs(root = RUNS_ROOT) {
  let reaped = 0
  for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const dir = path.join(root, name)
    let owner = null
    try {
      owner = fs.readFileSync(path.join(dir, 'owner'), 'utf8')
    } catch {
      const age = Date.now() - (fs.statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? Date.now())
      if (age < UNOWNED_GRACE_MS) {
        continue
      }
    }
    if (owner && processIdentity(Number(owner.split(' ')[0])) === owner) {
      continue
    }
    const appsDir = path.join(dir, 'apps')
    for (const entry of fs.existsSync(appsDir) ? fs.readdirSync(appsDir) : []) {
      try {
        const { identity, userDataDir } = JSON.parse(
          fs.readFileSync(path.join(appsDir, entry), 'utf8')
        )
        killAppGroup(Number(entry), identity, 'SIGKILL')
        await stopCopyDaemons(userDataDir)
      } catch {
        // A torn record proves nothing about any process.
      }
    }
    fs.rmSync(dir, { recursive: true, force: true })
    reaped += 1
  }
  return reaped
}
