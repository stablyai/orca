// Per-run app copies: profile copies the gate can make safely, and the terminal daemons a copy leaves behind.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const KILL_WAIT_MS = 5_000

/** Copies a profile without its daemon runtime dir: sockets can't be copied, and stale pid files would name other processes. */
export function copyProfile(sourceDir, targetDir) {
  const daemonDir = path.join(sourceDir, 'daemon')
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    mode: fs.constants.COPYFILE_FICLONE,
    filter: (source) => {
      if (source === daemonDir) {
        return false
      }
      const stat = fs.lstatSync(source, { throwIfNoEntry: false })
      return Boolean(stat) && !stat.isSocket() && !stat.isFIFO()
    }
  })
}

function readDaemonPids(userDataDir) {
  const daemonDir = path.join(userDataDir, 'daemon')
  if (!fs.existsSync(daemonDir)) {
    return []
  }
  const pids = []
  for (const entry of fs.readdirSync(daemonDir)) {
    if (!entry.endsWith('.pid')) {
      continue
    }
    let raw = ''
    try {
      raw = fs.readFileSync(path.join(daemonDir, entry), 'utf8').trim()
    } catch {
      continue
    }
    let pid = Number(raw)
    try {
      pid = JSON.parse(raw).pid ?? pid
    } catch {
      // A bare pid number.
    }
    if (Number.isInteger(pid) && pid > 1) {
      pids.push(pid)
    }
  }
  return pids
}

function descendantPids(rootPid) {
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

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * A normal quit keeps the terminal daemon and its shells running (as the e2e fixtures' cleanupE2EDaemons notes),
 * so a disposable copy must stop them itself or they load every later window.
 */
export async function stopCopyDaemons(userDataDir) {
  for (const root of readDaemonPids(userDataDir)) {
    const pids = [...descendantPids(root), root]
    for (const pid of pids.toReversed()) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // Already gone.
      }
    }
    const deadline = Date.now() + KILL_WAIT_MS
    while (pids.some(alive) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    for (const pid of pids.filter(alive)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  }
}
