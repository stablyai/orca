// Per-run app copies: profile copies the gate can make safely, and the terminal daemons a copy leaves behind.
import { execFileSync, spawnSync } from 'node:child_process'
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

/** A failed ps proves nothing either way: whoever holds a record must keep it and try again later. */
export class ProcessTableUnavailable extends Error {}

/** The live process with this pid, or null once ps has shown it gone; throws when ps itself fails. */
function processInfo(pid) {
  const r = spawnSync('ps', ['-o', 'lstart=,args=', '-p', String(pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, LC_ALL: 'C' }
  })
  const out = typeof r.stdout === 'string' ? r.stdout.trim() : ''
  if (!r.error && !r.signal && r.status === 0 && out) {
    const [started, ...args] = out.split(/(?<=^\S+ \S+ +\S+ \S+ \S+) /)
    return { startedAtMs: Date.parse(started), args: args.join(' ') }
  }
  if (!r.error && !r.signal && r.status === 1 && !out) {
    return null
  }
  throw new ProcessTableUnavailable(`ps couldn't read process ${String(pid)}`)
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
    let text = ''
    try {
      text = fs.readFileSync(recordPath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        continue
      }
      throw error
    }
    let record = null
    try {
      record = JSON.parse(text)
    } catch {
      // Torn, or a bare legacy pid with nothing to prove it is still the daemon.
      continue
    }
    // isRecordedDaemon throws when ps fails: that is never "no daemon".
    if (Number.isInteger(record?.pid) && record.pid > 1 && isRecordedDaemon(record, recordPath)) {
      pids.push(record.pid)
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
    throw new ProcessTableUnavailable("ps couldn't list processes")
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
      // TZ too: another gate compares these against the start times recorded below.
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }
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

async function readStartTimes() {
  let table = processStartTimes()
  for (let attempt = 0; table === null && attempt < 5; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    table = processStartTimes()
  }
  if (table === null) {
    throw new ProcessTableUnavailable("ps couldn't list process start times")
  }
  return table
}

// Each stopped daemon's tree, recorded before any signal: once the daemon exits, nothing else can find its children.
const TREE_RECORD = /^fleet-gate-tree-\d+\.json$/

function readTreeRecords(daemonDir) {
  let names = []
  try {
    names = fs.readdirSync(daemonDir).filter((name) => TREE_RECORD.test(name))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return []
    }
    throw error
  }
  return names.map((name) => {
    const file = path.join(daemonDir, name)
    try {
      return { file, members: JSON.parse(fs.readFileSync(file, 'utf8')) }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { file, members: [] }
      }
      throw error
    }
  })
}

function aliveMembers(members, table) {
  return members.filter(({ pid, started }) => table.get(pid) === started)
}

/** true while any process of a recorded daemon tree still runs (same pid and start time); throws when ps fails. */
export async function daemonTreesAlive(userDataDir) {
  const trees = readTreeRecords(path.join(userDataDir, 'daemon'))
  if (trees.length === 0) {
    return false
  }
  const table = await readStartTimes()
  return trees.some(({ members }) => aliveMembers(members, table).length > 0)
}

/**
 * A normal quit keeps the terminal daemon and its shells running (as the e2e fixtures' cleanupE2EDaemons notes),
 * so a disposable copy must stop them itself or they load every later window. Throws when ps can't prove what
 * it needs, so the caller keeps the copy's record for a later try.
 */
export async function stopCopyDaemons(userDataDir) {
  const daemonDir = path.join(userDataDir, 'daemon')
  // Trees an earlier stop recorded but couldn't finish: their daemon may be gone, but its children aren't.
  for (const { file, members } of readTreeRecords(daemonDir)) {
    const table = await readStartTimes()
    for (const { pid } of aliveMembers(members, table)) {
      signalPid(pid, 'SIGKILL')
    }
    if (aliveMembers(members, await readStartTimes()).length === 0) {
      fs.rmSync(file, { force: true })
    }
  }
  for (const root of readDaemonPids(userDataDir)) {
    const pids = [...descendantPids(root), root]
    // Start times before any signal: no baseline means nothing could later be proven gone or safe to SIGKILL.
    const startedAt = await readStartTimes()
    const members = pids
      .filter((pid) => startedAt.has(pid))
      .map((pid) => ({ pid, started: startedAt.get(pid) }))
    const treeFile = path.join(daemonDir, `fleet-gate-tree-${String(root)}.json`)
    fs.writeFileSync(`${treeFile}.new`, JSON.stringify(members))
    fs.renameSync(`${treeFile}.new`, treeFile)
    for (const pid of pids.toReversed()) {
      signalPid(pid, 'SIGTERM')
    }
    const deadline = Date.now() + KILL_WAIT_MS
    for (;;) {
      const table = processStartTimes()
      if ((table !== null && aliveMembers(members, table).length === 0) || Date.now() >= deadline) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    // Escalate only on a fresh, successful read; readStartTimes throws otherwise and the tree record stays.
    for (const { pid } of aliveMembers(members, await readStartTimes())) {
      signalPid(pid, 'SIGKILL')
    }
    if (aliveMembers(members, await readStartTimes()).length === 0) {
      fs.rmSync(treeFile, { force: true })
    }
  }
}

function signalPid(pid, signal) {
  try {
    process.kill(pid, signal)
  } catch {
    // Already gone.
  }
}
