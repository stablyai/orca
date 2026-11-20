// A copy's terminal daemon detaches into its own session, so a killed gate (SIGKILL, a timeout, a lost host) would leave
// it running forever. Each gate's run folder therefore records its owner, every copy (before it launches) and every
// helper process, and the next gate reaps folders whose owner is gone; a live gate also kills them on any exit.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CACHE_ROOT } from './fleet-gate-builds.mjs'
import { identityState, probeProcess, processIdentity } from './fleet-gate-cache-lock.mjs'
import {
  daemonTreesAlive,
  descendantPids,
  readDaemonPids,
  stopCopyDaemons
} from './fleet-gate-copies.mjs'

export const RUNS_ROOT = path.join(CACHE_ROOT, 'runs')
// A folder with no owner yet is one being created right now, unless it is this old.
const UNOWNED_GRACE_MS = 10 * 60_000
// pid -> { identity, userDataDir? } for this gate's own copies and helpers, killed on exit.
const live = new Map()
const sleeper = new Int32Array(new SharedArrayBuffer(4))

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

/**
 * Records a batch of helpers (Xvfb, CPU load) before they spawn, under a marker each carries on its command line (arg)
 * or, for a program that rejects unknown arguments, in its environment (env); record(pid) adds each one for the exit
 * kill, done() drops the marker once they are stopped.
 */
export function recordHelperLaunch(runDir) {
  const marker = randomUUID()
  const pending = path.join(ownerFolder(runDir), 'helpers', `pending-${marker}`)
  writeRecord(pending, { marker })
  return {
    arg: `--fleet-gate-helper=${marker}`,
    env: { FLEET_GATE_HELPER: marker },
    record: (pid) => {
      try {
        return recordHelper(runDir, pid)
      } catch {
        // Its marker still lets a reap find it.
        return () => {}
      }
    },
    done: () => fs.rmSync(pending, { force: true })
  }
}

/** Records a helper the gate spawned (Xvfb, CPU load); returns the call that forgets it once it is stopped. */
function recordHelper(runDir, pid) {
  const file = path.join(ownerFolder(runDir), 'helpers', String(pid))
  let identity = processIdentity(pid)
  for (let attempt = 0; !identity && attempt < 10; attempt += 1) {
    Atomics.wait(sleeper, 0, 0, 100)
    identity = processIdentity(pid)
  }
  if (!identity) {
    throw new Error(`can't read process ${String(pid)}'s start time with ps, so can't record it`)
  }
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
// false when ps failed, so the caller can't know whether the recorded process still runs.
function killVerified(pid, identity, group) {
  const state = identityState(identity)
  if (state === 'alive') {
    signal(pid, 'SIGKILL', group)
  }
  return state !== 'unknown'
}

/** true once every daemon recorded in userDataDir is provably gone; a failed ps or read is never proof. */
export async function daemonsGone(userDataDir) {
  const daemonDir = path.join(userDataDir, 'daemon')
  let names
  try {
    names = fs.readdirSync(daemonDir).filter((name) => name.endsWith('.pid'))
  } catch (error) {
    return error?.code === 'ENOENT'
  }
  for (const name of names) {
    let text = ''
    try {
      text = fs.readFileSync(path.join(daemonDir, name), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        continue
      }
      return false
    }
    let pid = null
    try {
      pid = JSON.parse(text).pid
    } catch {
      // Torn or legacy: nothing in it can name a process.
    }
    if (Number.isInteger(pid) && probeProcess(pid).state === 'unknown') {
      return false
    }
  }
  return readDaemonPids(userDataDir).length === 0 && !(await daemonTreesAlive(userDataDir))
}

/** For process 'exit': synchronous, so it also runs on a thrown error or process.exit. */
export function killLiveNow() {
  for (const [pid, { identity, userDataDir }] of live) {
    try {
      killVerified(pid, identity, Boolean(userDataDir))
      // readDaemonPids proves each daemon is this copy's (launch nonce, pid record, start time) just before the kill.
      for (const root of userDataDir ? readDaemonPids(userDataDir) : []) {
        for (const daemonPid of [...descendantPids(root), root]) {
          signal(daemonPid, 'SIGKILL', false)
        }
      }
    } catch {
      // ps failed: its records stay on disk, so the exit handler keeps the folder for the next gate's reap.
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

/** Records in apps/ or helpers/; throws on any read failure but a missing file, which is never "no records". */
function readRecords(dir) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch (error) {
    // Another gate reaped this folder first.
    if (error?.code === 'ENOENT') {
      return []
    }
    throw error
  }
  return names
    .filter((name) => !name.endsWith('.new'))
    .flatMap((name) => {
      let text = ''
      try {
        text = fs.readFileSync(path.join(dir, name), 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return []
        }
        throw error
      }
      try {
        return [{ name, ...JSON.parse(text) }]
      } catch {
        // Records appear whole by rename, so this one can't name a process.
        return []
      }
    })
}

/** Linux: pids whose environment holds exactly this entry, or null when /proc can't be listed. */
function pidsWithEnv(entry) {
  let pids = []
  try {
    pids = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name))
  } catch {
    return process.platform === 'linux' ? null : []
  }
  return pids
    .filter((pid) => {
      try {
        return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(entry)
      } catch (error) {
        // Exited, or another user's process (never ours); any other failure proves nothing, so the reap keeps the folder.
        if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error?.code)) {
          return false
        }
        throw error
      }
    })
    .map(Number)
}

function killByMarker(arg, group) {
  const pids = pidsCarrying(arg)
  for (const pid of pids ?? []) {
    signal(pid, 'SIGKILL', group)
  }
  return pids !== null
}

function killByEnvMarker(entry) {
  const pids = pidsWithEnv(entry)
  for (const pid of pids ?? []) {
    signal(pid, 'SIGKILL', false)
  }
  return pids !== null
}

/**
 * false when it couldn't prove every recorded process gone (a failed ps or read): the folder then stays, records
 * intact, for a later reap, since deleting it would orphan whatever still runs.
 */
async function reapFolder(dir) {
  try {
    return await reapFolderOrThrow(dir)
  } catch {
    // A failed ps or read: the folder stays for a later reap.
    return false
  }
}

async function reapFolderOrThrow(dir) {
  const inside = (userDataDir) =>
    typeof userDataDir === 'string' && !path.relative(dir, userDataDir).startsWith('..')
  for (const record of readRecords(path.join(dir, 'apps'))) {
    const settled = record.name.startsWith('pending-')
      ? killByMarker(`--fleet-gate-copy=${String(record.marker)}`, true)
      : killVerified(Number(record.name), record.identity, true)
    if (!settled) {
      return false
    }
    // Only daemons recorded inside this folder: a pid record anywhere else could be another gate's.
    if (inside(record.userDataDir)) {
      await stopCopyDaemons(record.userDataDir)
      if (!(await daemonsGone(record.userDataDir))) {
        return false
      }
    }
  }
  for (const record of readRecords(path.join(dir, 'helpers'))) {
    const pid = Number(record.name)
    const settled = record.name.startsWith('pending-')
      ? killByMarker(`--fleet-gate-helper=${String(record.marker)}`, false) &&
        killByEnvMarker(`FLEET_GATE_HELPER=${String(record.marker)}`)
      : killVerified(pid, record.identity, false)
    if (!settled) {
      return false
    }
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return true
}

/** For the exit handler: any record left is a process this gate couldn't prove stopped, so the folder must stay. */
export function hasRecords(dir) {
  return ['apps', 'helpers'].some((sub) => {
    try {
      return fs.readdirSync(path.join(dir, sub)).some((name) => !name.endsWith('.new'))
    } catch (error) {
      return error?.code !== 'ENOENT'
    }
  })
}

/** Deletes a copy's run folder unless a record still points into it (its daemon pid records must survive). */
export function removeRunDir(runDir) {
  try {
    const apps = readRecords(path.join(ownerFolder(runDir), 'apps'))
    if (
      apps.some((record) => !path.relative(runDir, String(record.userDataDir)).startsWith('..'))
    ) {
      return
    }
  } catch {
    // Unreadable records: keep the folder for the next gate's reap.
    return
  }
  fs.rmSync(runDir, { recursive: true, force: true })
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
