// A copy's terminal daemon detaches into its own session, so a killed gate (SIGKILL, a timeout, a lost host) would leave
// it running forever. Each gate's run folder therefore records its owner, every copy (before it launches) and every
// helper process, and the next gate reaps folders whose owner is gone; a live gate also kills them on any exit.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CACHE_ROOT } from './fleet-gate-builds.mjs'
import { identityState, processIdentity } from './fleet-gate-cache-lock.mjs'
import { descendantPids, readDaemonPids, stopCopyDaemons } from './fleet-gate-copies.mjs'

export const RUNS_ROOT = path.join(CACHE_ROOT, 'runs')
// A folder with no owner yet is one being created right now, unless it is this old.
const UNOWNED_GRACE_MS = 10 * 60_000
// pid -> { identity, userDataDir? } for this gate's own copies and helpers, killed on exit.
const live = new Map()

/** A fresh folder under the gate's cache, owned by this process (the owner file appears whole, by rename). */
export function createRunDir(prefix, root = RUNS_ROOT) {
  const owner = processIdentity(process.pid)
  if (!owner) {
    throw new Error("can't read this process's start time with ps, so can't own a run folder")
  }
  fs.mkdirSync(root, { recursive: true })
  const dir = fs.mkdtempSync(path.join(root, `${prefix}-`))
  for (const sub of ['apps', 'helpers', 'tmp']) {
    fs.mkdirSync(path.join(dir, sub))
  }
  fs.writeFileSync(path.join(dir, 'owner.new'), owner)
  fs.renameSync(path.join(dir, 'owner.new'), path.join(dir, 'owner'))
  return dir
}

function ownerFolder(dir) {
  for (let at = dir; at !== path.dirname(at); at = path.dirname(at)) {
    if (fs.existsSync(path.join(at, 'owner'))) {
      return at
    }
  }
  throw new Error(`${dir} is not inside a gate run folder`)
}

function writeRecord(file, record) {
  fs.writeFileSync(`${file}.new`, JSON.stringify(record))
  fs.renameSync(`${file}.new`, file)
}

/**
 * Records a copy before it launches, under a marker its command line carries, so a gate killed mid-launch is still
 * reaped. commit(pid) pins the record to the launched process; forget() drops it after a clean close.
 */
export function recordCopyLaunch(runDir, userDataDir) {
  const marker = randomUUID()
  const apps = path.join(ownerFolder(runDir), 'apps')
  const pending = path.join(apps, `pending-${marker}`)
  writeRecord(pending, { marker, userDataDir })
  let committed = null
  return {
    arg: `--fleet-gate-copy=${marker}`,
    commit(pid) {
      const identity = processIdentity(pid)
      if (!identity) {
        // ps failed: the pending record (found by marker) stays the copy's only proof.
        return
      }
      committed = path.join(apps, String(pid))
      writeRecord(committed, { identity, userDataDir })
      live.set(pid, { identity, userDataDir })
      fs.rmSync(pending, { force: true })
    },
    forget() {
      for (const [pid, entry] of live) {
        if (entry.userDataDir === userDataDir) {
          live.delete(pid)
        }
      }
      fs.rmSync(pending, { force: true })
      if (committed) {
        fs.rmSync(committed, { force: true })
      }
    }
  }
}

/** Records a helper the gate spawned (Xvfb, CPU load); returns the call that forgets it once it is stopped. */
export function recordHelper(runDir, pid) {
  const identity = processIdentity(pid)
  if (!identity) {
    return () => {}
  }
  const file = path.join(ownerFolder(runDir), 'helpers', String(pid))
  writeRecord(file, { identity })
  live.set(pid, { identity })
  return () => {
    live.delete(pid)
    fs.rmSync(file, { force: true })
  }
}

function signal(pid, sig, group) {
  try {
    process.kill(group ? -pid : pid, sig)
    return
  } catch {
    // No such group, or already gone.
  }
  try {
    process.kill(pid, sig)
  } catch {
    // Already gone.
  }
}

// Playwright starts the app in its own process group: this reaches its renderer, GPU and utility processes too.
function killVerified(pid, identity, group) {
  if (identityState(identity) === 'alive') {
    signal(pid, 'SIGKILL', group)
  }
}

/** For process 'exit': synchronous, so it also runs on a thrown error or process.exit. */
export function killLiveNow() {
  for (const [pid, { identity, userDataDir }] of live) {
    killVerified(pid, identity, Boolean(userDataDir))
    // readDaemonPids proves each daemon is this copy's (launch nonce, pid record, start time) just before the kill.
    for (const root of userDataDir ? readDaemonPids(userDataDir) : []) {
      for (const daemonPid of [...descendantPids(root), root]) {
        signal(daemonPid, 'SIGKILL', false)
      }
    }
  }
  live.clear()
}

/** pids whose command line has exactly this argument, or null when ps failed (unknown, never "none"). */
function pidsCarrying(arg) {
  try {
    return execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
      .split('\n')
      .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
      .filter((match) => match && match[2].split(' ').includes(arg))
      .map((match) => Number(match[1]))
  } catch {
    return null
  }
}

function readRecords(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => !name.endsWith('.new'))
      .flatMap((name) => {
        try {
          return [{ name, ...JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) }]
        } catch {
          return []
        }
      })
  } catch {
    // Another gate reaped this folder first.
    return []
  }
}

/** false when it couldn't prove a recorded copy gone; the folder then stays for a later reap. */
async function reapFolder(dir) {
  const inside = (userDataDir) =>
    typeof userDataDir === 'string' && !path.relative(dir, userDataDir).startsWith('..')
  for (const record of readRecords(path.join(dir, 'apps'))) {
    if (record.name.startsWith('pending-')) {
      const pids = pidsCarrying(`--fleet-gate-copy=${String(record.marker)}`)
      if (pids === null) {
        return false
      }
      for (const pid of pids) {
        signal(pid, 'SIGKILL', true)
      }
    } else {
      killVerified(Number(record.name), record.identity, true)
    }
    // Only daemons recorded inside this folder: a pid record anywhere else could be another gate's.
    if (inside(record.userDataDir)) {
      await stopCopyDaemons(record.userDataDir)
    }
  }
  for (const record of readRecords(path.join(dir, 'helpers'))) {
    killVerified(Number(record.name), record.identity, false)
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return true
}

/** Stops what dead gates left behind (verified processes only), then deletes their folders. */
export async function reapStaleRunDirs(root = RUNS_ROOT) {
  let reaped = 0
  for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const dir = path.join(root, name)
    let owner = ''
    try {
      owner = fs.readFileSync(path.join(dir, 'owner'), 'utf8')
    } catch {
      // No owner yet: being created, or a gate died before writing it.
    }
    if (!owner) {
      const modified = fs.statSync(dir, { throwIfNoEntry: false })?.mtimeMs
      if (modified === undefined || Date.now() - modified < UNOWNED_GRACE_MS) {
        continue
      }
    } else if (identityState(owner) !== 'dead') {
      // Alive, or ps failed: never reap a folder on a guess.
      continue
    }
    if (await reapFolder(dir)) {
      reaped += 1
    }
  }
  return reaped
}
