import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

function readDaemonPids(userDataPath) {
  const daemonDir = path.join(userDataPath, 'daemon')
  if (!existsSync(daemonDir)) {
    return []
  }
  const pids = []
  for (const entry of readdirSync(daemonDir)) {
    if (!entry.endsWith('.pid')) {
      continue
    }
    try {
      const raw = readFileSync(path.join(daemonDir, entry), 'utf8').trim()
      try {
        const parsed = JSON.parse(raw)
        if (Number.isInteger(parsed?.pid)) {
          pids.push(parsed.pid)
        }
      } catch {
        const pid = Number(raw)
        if (Number.isInteger(pid)) {
          pids.push(pid)
        }
      }
    } catch {
      // Another isolated process may retire its PID record during cleanup.
    }
  }
  return pids
}

function readPosixDescendants(rootPid) {
  try {
    const output = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' })
    const childrenByParent = new Map()
    for (const line of output.split('\n')) {
      const [pidText, parentText] = line.trim().split(/\s+/)
      const pid = Number(pidText)
      const parent = Number(parentText)
      if (!Number.isInteger(pid) || !Number.isInteger(parent)) {
        continue
      }
      childrenByParent.set(parent, [...(childrenByParent.get(parent) ?? []), pid])
    }
    const descendants = []
    const pending = [...(childrenByParent.get(rootPid) ?? [])]
    while (pending.length > 0) {
      const pid = pending.pop()
      if (!pid) {
        continue
      }
      descendants.push(pid)
      pending.push(...(childrenByParent.get(pid) ?? []))
    }
    return descendants
  } catch {
    return []
  }
}

export async function cleanupIsolatedDaemons(userDataPath) {
  const trackedPids = new Set()
  for (const pid of readDaemonPids(userDataPath)) {
    if (process.platform === 'win32') {
      trackedPids.add(pid)
      try {
        execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
      } catch {
        // The isolated daemon may already have exited.
      }
      continue
    }
    const pids = [...readPosixDescendants(pid), pid].toReversed()
    pids.forEach((targetPid) => trackedPids.add(targetPid))
    for (const targetPid of pids) {
      try {
        process.kill(targetPid, 'SIGTERM')
      } catch {
        // The isolated process may already have exited.
      }
    }
  }

  let survivors = await waitForProcessExit([...trackedPids], 1_000)
  for (const targetPid of survivors) {
    if (process.platform === 'win32') {
      continue
    }
    try {
      process.kill(targetPid, 'SIGKILL')
    } catch {
      // The isolated process may already have exited.
    }
  }
  survivors = await waitForProcessExit(survivors, 5_000)
  if (survivors.length > 0) {
    throw new Error(`isolated daemon cleanup left live processes: ${survivors.join(', ')}`)
  }
}

async function waitForProcessExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let survivors = pids.filter(isProcessAlive)
  while (survivors.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    survivors = survivors.filter(isProcessAlive)
  }
  return survivors
}
