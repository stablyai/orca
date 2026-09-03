import type { ChildProcessHandle } from '../../shared/child-process/run-process'
import { captureDescendantSnapshot, type DescendantSnapshot } from '../pty-descendant-termination'
import { terminateDescendantSnapshotAndWait } from '../pty-descendant-exit-verification'
import { terminateWindowsProcessTree } from '../windows-process-tree-kill'
import { findAgentSessionSpawnTokenProcesses } from '../runtime/agent-session-spawn-token-process-scan'
import { recordSelfInitiatedTreeKill } from '../crash-reporting/self-initiated-tree-kill-log'

const TOKEN_PROCESS_EXIT_TIMEOUT_MS = 3_500
const TOKEN_PROCESS_POLL_MS = 25
const activeTeardowns = new WeakMap<object, Promise<boolean>>()

type TeardownChild = Pick<ChildProcessHandle, 'pid' | 'kill'>

export type CodexAppServerProcessTeardownDeps = {
  platform?: NodeJS.Platform
  dedicatedProcessGroup?: boolean
  /** Diagnostic/recovery injection only; never used by the primary teardown. */
  findSpawnTokenProcesses?: (spawnToken: string) => Promise<number[] | null>
  captureDescendants?: (rootPid: number) => Promise<DescendantSnapshot | null>
  terminateDescendants?: (snapshot: DescendantSnapshot) => Promise<boolean>
  terminateWindowsTree?: (rootPid: number, deps?: { site?: string }) => Promise<void>
  signalPid?: (pid: number, signal: NodeJS.Signals) => void
  signalProcessGroup?: (pgid: number, signal: NodeJS.Signals) => void
  isPidPresent?: (pid: number) => boolean
  wait?: (ms: number) => Promise<void>
  now?: () => number
}

function terminateDedicatedPosixGroup(
  rootPid: number,
  deps: CodexAppServerProcessTeardownDeps
): boolean {
  const signalGroup =
    deps.signalProcessGroup ??
    ((pgid: number, signal: NodeJS.Signals) => process.kill(-pgid, signal))
  try {
    signalGroup(rootPid, 'SIGKILL')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
  // Outside the try: that catch is the ESRCH contract, not a breadcrumb handler.
  recordSelfInitiatedTreeKill({
    pid: rootPid,
    site: 'codex-app-server-teardown',
    scope: 'posix-process-group'
  })
  return true
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // An already-gone exact PID is the desired outcome.
  }
}

function isPidPresent(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function diagnosticTokenFallback(
  rootPid: number,
  spawnToken: string,
  deps: CodexAppServerProcessTeardownDeps
): Promise<boolean> {
  const find = deps.findSpawnTokenProcesses ?? findAgentSessionSpawnTokenProcesses
  const signal = deps.signalPid ?? sendSignal
  const pidPresent = deps.isPidPresent ?? isPidPresent
  const delay =
    deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = deps.now ?? Date.now
  const deadline = now() + TOKEN_PROCESS_EXIT_TIMEOUT_MS
  const signalled = new Set<number>()
  while (now() < deadline) {
    const pids = await find(spawnToken).catch(() => null)
    if (pids === null) {
      return false
    }
    for (const pid of pids.filter((candidate) => candidate !== rootPid)) {
      signalled.add(pid)
      signal(pid, 'SIGKILL')
    }
    if ([...signalled].every((pid) => !pidPresent(pid))) {
      return true
    }
    await delay(TOKEN_PROCESS_POLL_MS)
  }
  return false
}

async function terminatePosixTree(
  child: TeardownChild,
  rootPid: number,
  _spawnToken: string | undefined,
  deps: CodexAppServerProcessTeardownDeps
): Promise<boolean> {
  // Kept only for explicit recovery callers/tests. Production always follows
  // the dedicated process-group path below; token enumeration is evidence,
  // never the owner of orphan-reaping decisions.
  if (_spawnToken && deps.findSpawnTokenProcesses) {
    const reaped = await diagnosticTokenFallback(rootPid, _spawnToken, deps)
    if (reaped) {
      child.kill('SIGKILL')
      return true
    }
    return false
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
  // A detached POSIX launch is the leader of its own process group. Group
  // signalling reaches grandchildren even after they daemonise/reparent,
  // while the stopped root and captured pgid make the ownership proof exact.
  // The identity-gated descendant sweep remains the fallback for older hosts
  // or launches that could not establish a dedicated group.
  if (descendantsExited && snapshot.rootPgid === rootPid) {
    const signalGroup =
      deps.signalProcessGroup ??
      ((pgid: number, signal: NodeJS.Signals) => {
        try {
          process.kill(-pgid, signal)
        } catch {
          // Group already exited.
        }
      })
    signalGroup(snapshot.rootPgid, 'SIGKILL')
    recordSelfInitiatedTreeKill({
      pid: snapshot.rootPgid,
      site: 'codex-app-server-teardown',
      scope: 'posix-process-group'
    })
  }
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
    await terminate(rootPid, { site: 'codex-app-server-teardown' })
    // taskkill owns the tree; this preserves the prior direct-child fallback when it fails.
    child.kill('SIGKILL')
    return true
  }
  if (deps.dedicatedProcessGroup) {
    return terminateDedicatedPosixGroup(rootPid, deps)
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
