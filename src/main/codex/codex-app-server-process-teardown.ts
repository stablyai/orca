import type { ChildProcessHandle } from '../../shared/child-process/run-process'
import { captureDescendantSnapshot, type DescendantSnapshot } from '../pty-descendant-termination'
import { terminateDescendantSnapshotAndWait } from '../pty-descendant-exit-verification'
import { terminateWindowsProcessTree } from '../windows-process-tree-kill'
import { recordSelfInitiatedTreeKill } from '../crash-reporting/self-initiated-tree-kill-log'

const activeTeardowns = new WeakMap<object, Promise<boolean>>()

type TeardownChild = Pick<ChildProcessHandle, 'pid' | 'kill'>

export type CodexAppServerProcessTeardownDeps = {
  platform?: NodeJS.Platform
  dedicatedProcessGroup?: boolean
  captureDescendants?: (rootPid: number) => Promise<DescendantSnapshot | null>
  terminateDescendants?: (snapshot: DescendantSnapshot) => Promise<boolean>
  terminateWindowsTree?: (rootPid: number, deps?: { site?: string }) => Promise<void>
  signalProcessGroup?: (pgid: number, signal: NodeJS.Signals) => void
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

async function terminatePosixTree(
  child: TeardownChild,
  rootPid: number,
  deps: CodexAppServerProcessTeardownDeps
): Promise<boolean> {
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
      ((pgid: number, signal: NodeJS.Signals) => process.kill(-pgid, signal))
    let groupSignalled = false
    try {
      signalGroup(snapshot.rootPgid, 'SIGKILL')
      groupSignalled = true
    } catch {
      // Already-gone is still the desired outcome, but nothing here killed it,
      // and a crumb for a kill we never landed is a false render-process-gone suspect.
    }
    if (groupSignalled) {
      // Outside the try, as in terminateDedicatedPosixGroup: that catch is the
      // already-gone contract, not a breadcrumb handler.
      recordSelfInitiatedTreeKill({
        pid: snapshot.rootPgid,
        site: 'codex-app-server-teardown',
        scope: 'posix-process-group'
      })
    }
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
  return terminatePosixTree(child, rootPid, deps)
}

export function terminateCodexAppServerProcessTree(
  child: TeardownChild,
  deps: CodexAppServerProcessTeardownDeps = {}
): Promise<boolean> {
  const key = child as object
  const active = activeTeardowns.get(key)
  if (active) {
    return active
  }
  const attempt = terminateOnce(child, deps).catch(() => false)
  activeTeardowns.set(key, attempt)
  void attempt.then(() => {
    if (activeTeardowns.get(key) === attempt) {
      activeTeardowns.delete(key)
    }
  })
  return attempt
}
