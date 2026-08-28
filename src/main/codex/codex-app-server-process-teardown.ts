import type { ChildProcess } from 'node:child_process'
import { captureDescendantSnapshot, type DescendantSnapshot } from '../pty-descendant-termination'
import { terminateDescendantSnapshotAndWait } from '../pty-descendant-exit-verification'
import { findAgentSessionSpawnTokenProcesses } from '../runtime/agent-session-spawn-token-process-scan'
import { terminateWindowsProcessTree } from '../windows-process-tree-kill'

const TOKEN_PROCESS_EXIT_TIMEOUT_MS = 3_500
const TOKEN_PROCESS_POLL_MS = 25
const activeTeardowns = new WeakMap<object, Promise<boolean>>()

type TeardownChild = Pick<ChildProcess, 'pid' | 'kill'>

export type CodexAppServerProcessTeardownDeps = {
  platform?: NodeJS.Platform
  findSpawnTokenProcesses?: (spawnToken: string) => Promise<number[] | null>
  captureDescendants?: (rootPid: number) => Promise<DescendantSnapshot | null>
  terminateDescendants?: (snapshot: DescendantSnapshot) => Promise<boolean>
  terminateWindowsTree?: (rootPid: number) => Promise<void>
  signalPid?: (pid: number, signal: NodeJS.Signals) => void
  isPidPresent?: (pid: number) => boolean
  wait?: (ms: number) => Promise<void>
  now?: () => number
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // An already-gone exact PID is the desired outcome.
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function isPidPresent(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function terminateSpawnTokenProcesses(
  rootPid: number,
  spawnToken: string,
  deps: CodexAppServerProcessTeardownDeps
): Promise<boolean> {
  const find = deps.findSpawnTokenProcesses ?? findAgentSessionSpawnTokenProcesses
  const signal = deps.signalPid ?? sendSignal
  const pidPresent = deps.isPidPresent ?? isPidPresent
  const delay = deps.wait ?? wait
  const now = deps.now ?? Date.now
  const deadline = now() + TOKEN_PROCESS_EXIT_TIMEOUT_MS
  const signalled = new Set<number>()
  let emptyScans = 0

  while (now() < deadline) {
    const pids = await find(spawnToken).catch(() => null)
    if (pids === null) {
      return false
    }
    const descendants = pids.filter((pid) => pid !== rootPid)
    for (const pid of descendants) {
      signalled.add(pid)
      signal(pid, 'SIGKILL')
    }
    const allSignalledPidsGone = [...signalled].every((pid) => !pidPresent(pid))
    emptyScans = descendants.length === 0 && allSignalledPidsGone ? emptyScans + 1 : 0
    if (emptyScans >= 2) {
      return true
    }
    await delay(TOKEN_PROCESS_POLL_MS)
  }
  const remaining = await find(spawnToken).catch(() => null)
  return (
    remaining !== null &&
    remaining.every((pid) => pid === rootPid) &&
    [...signalled].every((pid) => !pidPresent(pid))
  )
}

async function terminatePosixTree(
  child: TeardownChild,
  rootPid: number,
  spawnToken: string | undefined,
  deps: CodexAppServerProcessTeardownDeps
): Promise<boolean> {
  const platform = deps.platform ?? process.platform
  if (platform === 'linux' && spawnToken) {
    const descendantsExited = await terminateSpawnTokenProcesses(rootPid, spawnToken, deps)
    if (descendantsExited) {
      child.kill('SIGKILL')
    }
    return descendantsExited
  }
  child.kill('SIGSTOP')
  const capture = deps.captureDescendants ?? captureDescendantSnapshot
  const snapshot = await capture(rootPid).catch(() => null)
  if (!snapshot) {
    child.kill('SIGKILL')
    return true
  }
  const terminate = deps.terminateDescendants ?? terminateDescendantSnapshotAndWait
  const descendantsExited = await terminate(snapshot)
  if (!descendantsExited) {
    child.kill('SIGCONT')
    return false
  }
  child.kill('SIGKILL')
  return true
}

/** Stops every process owned by one app-server launch before releasing its wrapper. */
async function terminateOnce(
  child: TeardownChild,
  spawnToken: string | undefined,
  deps: CodexAppServerProcessTeardownDeps
): Promise<boolean> {
  const rootPid = child.pid
  if (!rootPid) {
    child.kill('SIGKILL')
    return false
  }
  if ((deps.platform ?? process.platform) === 'win32') {
    const terminate = deps.terminateWindowsTree ?? terminateWindowsProcessTree
    await terminate(rootPid)
    // taskkill owns the tree; this preserves the prior direct-child fallback when it fails.
    child.kill('SIGKILL')
    return true
  }
  return terminatePosixTree(child, rootPid, spawnToken, deps)
}

export function terminateCodexAppServerProcessTree(
  child: TeardownChild,
  spawnToken?: string,
  deps: CodexAppServerProcessTeardownDeps = {}
): Promise<boolean> {
  const key = child as object
  const active = activeTeardowns.get(key)
  if (active) {
    return active
  }
  const attempt = terminateOnce(child, spawnToken, deps).catch(() => false)
  activeTeardowns.set(key, attempt)
  void attempt.then(() => {
    if (activeTeardowns.get(key) === attempt) {
      activeTeardowns.delete(key)
    }
  })
  return attempt
}
