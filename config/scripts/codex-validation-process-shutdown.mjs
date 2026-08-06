import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const GRACEFUL_CLOSE_TIMEOUT_MS = 10_000
const PROCESS_EXIT_TIMEOUT_MS = 5_000
const FORCE_KILL_WAIT_MS = 2_000

function delay(ms) {
  // Why: after Electron dies, this may be the standalone harness's only active
  // handle; keeping it referenced ensures daemon cleanup reaches completion.
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function hasExited(childProcess) {
  return childProcess.exitCode !== null || childProcess.signalCode !== null
}

function waitForExit(childProcess, timeoutMs) {
  if (hasExited(childProcess)) {
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (exited) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      childProcess.off('exit', onExit)
      childProcess.off('close', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    const timeout = setTimeout(() => finish(false), timeoutMs)
    childProcess.once('exit', onExit)
    childProcess.once('close', onExit)
  })
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout = null
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
      })
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

function readPosixDescendantPids(rootPid) {
  try {
    const output = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' })
    const childrenByParent = new Map()
    for (const line of output.split('\n')) {
      const [pidText, ppidText] = line.trim().split(/\s+/)
      const pid = Number(pidText)
      const ppid = Number(ppidText)
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) {
        continue
      }
      const children = childrenByParent.get(ppid) ?? []
      children.push(pid)
      childrenByParent.set(ppid, children)
    }

    const descendants = []
    const stack = [...(childrenByParent.get(rootPid) ?? [])]
    while (stack.length > 0) {
      const pid = stack.pop()
      if (!pid) {
        continue
      }
      descendants.push(pid)
      stack.push(...(childrenByParent.get(pid) ?? []))
    }
    return descendants
  } catch {
    return []
  }
}

function killPid(pid, signal) {
  try {
    process.kill(pid, signal)
  } catch {
    /* already dead or inaccessible */
  }
}

async function forceKillPidTree(pid) {
  if (!pid) {
    return
  }

  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* already dead or taskkill unavailable */
    }
    return
  }

  // Why: a detached validation daemon can outlive Electron and retain access
  // to the disposable credential root unless the whole tree is captured first.
  const pids = [...readPosixDescendantPids(pid), pid]
  for (const targetPid of [...pids].toReversed()) {
    killPid(targetPid, 'SIGTERM')
  }
  await delay(FORCE_KILL_WAIT_MS)
  for (const targetPid of [...pids].toReversed()) {
    killPid(targetPid, 'SIGKILL')
  }
}

export async function closeValidationElectronApp(app) {
  if (!app) {
    return
  }

  const childProcess = app.process()
  try {
    await withTimeout(
      app.close(),
      GRACEFUL_CLOSE_TIMEOUT_MS,
      'Timed out closing validation Electron app'
    )
    if (childProcess) {
      const exited = await waitForExit(childProcess, PROCESS_EXIT_TIMEOUT_MS)
      if (!exited) {
        await forceKillPidTree(childProcess.pid)
        await waitForExit(childProcess, PROCESS_EXIT_TIMEOUT_MS)
      }
    }
  } catch {
    if (childProcess && !hasExited(childProcess)) {
      await forceKillPidTree(childProcess.pid)
      await waitForExit(childProcess, PROCESS_EXIT_TIMEOUT_MS)
    }
  }
}

function readValidationDaemonPids(userDataDir) {
  const daemonDir = path.join(userDataDir, 'daemon')
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
      const parsed = JSON.parse(raw)
      if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid)) {
        pids.push(parsed.pid)
      }
    } catch {
      const pid = Number(readFileSync(path.join(daemonDir, entry), 'utf8').trim())
      if (Number.isInteger(pid)) {
        pids.push(pid)
      }
    }
  }
  return pids
}

export async function cleanupValidationDaemons(userDataDir) {
  // Why: Orca intentionally keeps its daemon warm after app quit, but this
  // harness must never leave a process holding disposable account credentials.
  for (const pid of readValidationDaemonPids(userDataDir)) {
    await forceKillPidTree(pid)
  }
}
