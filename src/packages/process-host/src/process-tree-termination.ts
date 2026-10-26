import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { admitProcessTreeKill } from './process-tree-kill-gate'
import {
  startWindowsTreeKill,
  trackedWindowsTreeKill,
  waitForWindowsTreeKill
} from './windows-tree-kill'

const PROBE_INTERVAL_MS = 25
const SUBPROCESS_TIMEOUT_MS = 2_000
const MAX_PS_OUTPUT_BYTES = 8 * 1024 * 1024

/** POSIX children must be detached: signaling -pid targets the process group. */
export function signalProcessTree(child: ChildProcess, signal?: NodeJS.Signals): Promise<boolean> {
  if (!child.pid) {
    killRoot(child, signal)
    return Promise.resolve(true)
  }
  if (process.platform === 'win32') {
    // A tracked taskkill may have killed the root already; join its verdict before checking exit.
    const tracked = trackedWindowsTreeKill(child)
    if (tracked) {
      return waitForWindowsTreeKill(tracked)
    }
    // A reaped Windows PID can be reused; root exit alone does not prove descendants are gone.
    if (childProcessHasExited(child)) {
      killRoot(child, signal)
      return Promise.resolve(false)
    }
    return taskkillTree(child, child.pid, signal)
  }
  if (
    !admitProcessTreeKill({
      pid: child.pid,
      site: 'run-process-tree',
      scope: 'posix-process-group'
    })
  ) {
    // Refuse the group kill but still terminate the root through its handle.
    killRoot(child, signal)
    return Promise.resolve(false)
  }
  try {
    process.kill(-child.pid, signal)
    return Promise.resolve(true)
  } catch {
    return Promise.resolve(!processGroupExists(child.pid))
  }
}

export async function forceTerminateProcessTree(child: ChildProcess): Promise<boolean> {
  const signaled = await signalProcessTree(child, 'SIGKILL')
  if (!signaled) {
    return false
  }
  if (process.platform !== 'win32' && child.pid) {
    return waitForPosixProcessGroupQuiescence(child.pid)
  }
  return true
}

/** A stubbed child leaves both undefined; only a real code or signal proves exit. */
export function childProcessHasExited(child: ChildProcess): boolean {
  return (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null
}

function taskkillTree(
  child: ChildProcess,
  rootPid: number,
  signal?: NodeJS.Signals
): Promise<boolean> {
  if (
    !admitProcessTreeKill({ pid: rootPid, site: 'run-process-tree', scope: 'win-taskkill-tree' })
  ) {
    killRoot(child, signal)
    return Promise.resolve(false)
  }
  return waitForWindowsTreeKill(startWindowsTreeKill(child, rootPid, () => killRoot(child, signal)))
}

async function waitForPosixProcessGroupQuiescence(processGroupId: number): Promise<boolean> {
  const deadline = Date.now() + SUBPROCESS_TIMEOUT_MS
  while (true) {
    const states = await readPosixProcessGroupStates(processGroupId)
    if (
      states ? states.every((state) => state.startsWith('Z')) : !processGroupExists(processGroupId)
    ) {
      return true
    }
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise<void>((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS))
  }
}

function readPosixProcessGroupStates(processGroupId: number): Promise<string[] | null> {
  return new Promise((resolve) => {
    let probe: ChildProcess
    try {
      probe = nodeSpawn('ps', ['-axo', 'pgid=,state='], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        shell: false
      })
    } catch {
      resolve(null)
      return
    }
    let output = ''
    let truncated = false
    let settled = false
    const finish = (states: string[] | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(states)
    }
    probe.stdout?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString()
      if (output.length + text.length > MAX_PS_OUTPUT_BYTES) {
        truncated = true
        return
      }
      output += text
    })
    probe.stdout?.on('error', () => {})
    probe.once('error', () => finish(null))
    probe.once('close', (code) => {
      if (code !== 0 || truncated) {
        finish(null)
        return
      }
      const states = output.split('\n').flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(\S+)/)
        return match && Number(match[1]) === processGroupId ? [match[2]] : []
      })
      finish(states)
    })
    const timer = setTimeout(() => {
      probe.kill()
      finish(null)
    }, SUBPROCESS_TIMEOUT_MS)
    timer.unref?.()
  })
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    return !(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ESRCH'
    )
  }
}

function killRoot(child: ChildProcess, signal?: NodeJS.Signals): void {
  try {
    child.kill(signal)
  } catch {
    /* already gone */
  }
}
