// Per-run app copies: profile copies the gate can make safely, and the terminal daemons a copy leaves behind.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const KILL_WAIT_MS = 5_000

/** Copies a profile without its daemon runtime dir: sockets can't be copied, and stale pid files would name other processes. */
export function copyProfile(seedDir, targetDir) {
  // The real path: the filter below drops symlinks, and cpSync applies it to the root too.
  const sourceDir = fs.realpathSync(seedDir)
  const daemonDir = path.join(sourceDir, 'daemon')
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    mode: fs.constants.COPYFILE_FICLONE,
    filter: (source) => {
      if (source === daemonDir) {
        return false
      }
      const stat = fs.lstatSync(source, { throwIfNoEntry: false })
      // Symlinks are dropped: a copied link can point back into the seed (Chromium's Singleton* links are per-run anyway).
      return Boolean(stat) && (stat.isFile() || stat.isDirectory())
    }
  })
  copyInternalLinkedFiles(sourceDir, targetDir, daemonDir)
}

/** A link to a file inside the seed (e.g. a linked orca-data.json) becomes a real copy of its target, never a link back. */
function copyInternalLinkedFiles(sourceDir, targetDir, daemonDir) {
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (full === daemonDir) {
        continue
      }
      if (entry.isDirectory()) {
        visit(full)
      } else if (entry.isSymbolicLink()) {
        let real = ''
        try {
          real = fs.realpathSync(full)
        } catch {
          continue
        }
        if (real.startsWith(`${sourceDir}${path.sep}`) && fs.statSync(real).isFile()) {
          fs.copyFileSync(real, path.join(targetDir, path.relative(sourceDir, full)))
        }
      }
    }
  }
  visit(sourceDir)
}

function processInfo(pid) {
  try {
    const [started, ...args] = execFileSync('ps', ['-o', 'lstart=,args=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' }
    })
      .trim()
      .split(/(?<=^\S+ \S+ +\S+ \S+ \S+) /)
    return { startedAtMs: Date.parse(started), args: args.join(' ') }
  } catch {
    return null
  }
}

/**
 * A live process is this copy's daemon only if it was launched for this very pid record with the recorded launch
 * nonce (both are on its command line) and started when the record says; a reused pid or another copy's daemon fails.
 */
function isRecordedDaemon(record, recordPath) {
  const live = processInfo(record.pid)
  return (
    live !== null &&
    typeof record.launchNonce === 'string' &&
    record.launchNonce !== '' &&
    live.args.includes(`--launch-nonce ${record.launchNonce}`) &&
    live.args.includes(`--pid-record ${recordPath}`) &&
    typeof record.startedAtMs === 'number' &&
    Math.abs(live.startedAtMs - record.startedAtMs) < 60_000
  )
}

export function readDaemonPids(userDataDir) {
  const daemonDir = path.join(userDataDir, 'daemon')
  if (!fs.existsSync(daemonDir)) {
    return []
  }
  let entries = []
  try {
    entries = fs.readdirSync(daemonDir)
  } catch (error) {
    // Another gate's reap removed it first; any other failure must not pass for "no daemons".
    if (error?.code === 'ENOENT') {
      return []
    }
    throw error
  }
  const pids = []
  for (const entry of entries) {
    if (!entry.endsWith('.pid')) {
      continue
    }
    const recordPath = path.join(daemonDir, entry)
    try {
      const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'))
      if (Number.isInteger(record.pid) && record.pid > 1 && isRecordedDaemon(record, recordPath)) {
        pids.push(record.pid)
      }
    } catch {
      // Gone, torn, or a bare legacy pid with nothing to prove it is still the daemon.
    }
  }
  return pids
}

export function descendantPids(rootPid) {
  const childrenByParent = new Map()
  try {
    for (const line of execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' }).split(
      '\n'
    )) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number)
      if (Number.isInteger(pid) && Number.isInteger(ppid)) {
        childrenByParent.set(ppid, [...(childrenByParent.get(ppid) ?? []), pid])
      }
    }
  } catch {
    return []
  }
  const found = []
  const stack = [...(childrenByParent.get(rootPid) ?? [])]
  while (stack.length > 0) {
    const pid = stack.pop()
    found.push(pid)
    stack.push(...(childrenByParent.get(pid) ?? []))
  }
  return found
}

/** pid -> start time for every process, from one ps call. */
function processStartTimes() {
  const table = new Map()
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' }
    })
    for (const line of out.split('\n')) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line)
      if (match) {
        table.set(Number(match[1]), match[2].trim())
      }
    }
  } catch {
    // A failed read is no evidence either way: the caller keeps waiting and never escalates on it.
    return null
  }
  return table
}

/**
 * A normal quit keeps the terminal daemon and its shells running (as the e2e fixtures' cleanupE2EDaemons notes),
 * so a disposable copy must stop them itself or they load every later window.
 */
export async function stopCopyDaemons(userDataDir) {
  for (const root of readDaemonPids(userDataDir)) {
    const pids = [...descendantPids(root), root]
    // Start times now, so the SIGKILL below never reaches a process that reused one of these pids.
    let startedAt = processStartTimes()
    for (let attempt = 0; startedAt === null && attempt < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      startedAt = processStartTimes()
    }
    // No baseline: nothing can be proven gone or safe to SIGKILL, so the loop below waits out the full grace.
    const unknownBaseline = startedAt === null
    startedAt ??= new Map()
    const same = (table) => (pid) => startedAt.has(pid) && table?.get(pid) === startedAt.get(pid)
    const stillRunning = () => {
      const table = processStartTimes()
      return table === null || unknownBaseline ? pids : pids.filter(same(table))
    }
    for (const pid of pids.toReversed()) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // Already gone.
      }
    }
    const deadline = Date.now() + KILL_WAIT_MS
    while (stillRunning().length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    // Escalate only on a fresh, successful read.
    const latest = processStartTimes()
    for (const pid of latest === null ? [] : pids.filter(same(latest))) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  }
}
