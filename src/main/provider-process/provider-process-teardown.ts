import type { ChildProcessHandle } from '../../shared/child-process/run-process'
import { captureDescendantSnapshot, type DescendantSnapshot } from '../pty-descendant-termination'
import {
  terminateDescendantSnapshotWithVerdict,
  type DescendantTreeVerdict
} from '../pty-descendant-exit-verification'
import { terminateWindowsProcessTree } from '../windows-process-tree-kill'
import { recordSelfInitiatedTreeKill } from '../crash-reporting/self-initiated-tree-kill-log'

/** What the teardown observed of the descendants; null when it signalled but observed nothing. */
export type ProviderProcessTeardownVerdict = DescendantTreeVerdict | null

const activeTeardowns = new WeakMap<object, Promise<ProviderProcessTeardownVerdict>>()

type TeardownChild = Pick<ChildProcessHandle, 'pid' | 'kill'>

export type ProviderProcessTeardownDeps = {
  site: string
  platform?: NodeJS.Platform
  dedicatedProcessGroup?: boolean
  captureDescendants?: (rootPid: number) => Promise<DescendantSnapshot | null>
  terminateDescendants?: (snapshot: DescendantSnapshot) => Promise<DescendantTreeVerdict>
  /** Resolves true only when taskkill reports the whole tree terminated. */
  terminateWindowsTree?: (rootPid: number, deps?: { site?: string }) => Promise<boolean>
  signalProcessGroup?: (pgid: number, signal: NodeJS.Signals) => void
}

function terminateDedicatedPosixGroup(
  rootPid: number,
  deps: ProviderProcessTeardownDeps
): ProviderProcessTeardownVerdict {
  const signalGroup =
    deps.signalProcessGroup ??
    ((pgid: number, signal: NodeJS.Signals) => process.kill(-pgid, signal))
  try {
    signalGroup(rootPid, 'SIGKILL')
  } catch (error) {
    // ESRCH says only that the group is empty; a descendant that left it, or a root that never led it, may live.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Node process.kill errors expose an optional errno code; only that field is read.
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? null : 'unverifiable'
  }
  // Outside the try: that catch is the ESRCH contract, not a breadcrumb handler.
  recordSelfInitiatedTreeKill({
    pid: rootPid,
    site: deps.site,
    scope: 'posix-process-group'
  })
  // A delivered signal is not an observed exit.
  return null
}

async function terminatePosixTree(
  child: TeardownChild,
  rootPid: number,
  deps: ProviderProcessTeardownDeps
): Promise<ProviderProcessTeardownVerdict> {
  child.kill('SIGSTOP')
  const capture = deps.captureDescendants ?? captureDescendantSnapshot
  const snapshot = await capture(rootPid).catch(() => null)
  if (!snapshot) {
    // No observation rather than the reaper's `unverifiable`: Codex's diagnostic treated this as accepted.
    // The reaper-move follow-up maps it to `unverifiable` and takes that Codex change deliberately.
    child.kill('SIGKILL')
    return null
  }
  const terminate =
    deps.terminateDescendants ??
    ((captured: DescendantSnapshot) => terminateDescendantSnapshotWithVerdict(captured))
  const verdict = await terminate(snapshot)
  const descendantsExited = verdict === 'exited'
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
        site: deps.site,
        scope: 'posix-process-group'
      })
    }
  }
  if (!descendantsExited) {
    child.kill('SIGCONT')
    return verdict
  }
  child.kill('SIGKILL')
  return 'exited'
}

/** Stops every process owned by one provider launch before releasing its wrapper. */
async function terminateOnce(
  child: TeardownChild,
  deps: ProviderProcessTeardownDeps
): Promise<ProviderProcessTeardownVerdict> {
  const rootPid = child.pid
  if (!rootPid) {
    child.kill('SIGKILL')
    return 'unverifiable'
  }
  if ((deps.platform ?? process.platform) === 'win32') {
    const terminate = deps.terminateWindowsTree ?? terminateWindowsProcessTree
    const treeTerminated = await terminate(rootPid, { site: deps.site })
    // taskkill owns the tree; this preserves the prior direct-child fallback when it fails.
    child.kill('SIGKILL')
    // Taskkill's own report, not an observation: only its clean exit says the tree is gone.
    return treeTerminated ? 'exited' : 'unverifiable'
  }
  if (deps.dedicatedProcessGroup) {
    return terminateDedicatedPosixGroup(rootPid, deps)
  }
  return terminatePosixTree(child, rootPid, deps)
}

export function terminateProviderProcessTree(
  child: TeardownChild,
  deps: ProviderProcessTeardownDeps
): Promise<ProviderProcessTeardownVerdict> {
  const key = child
  const active = activeTeardowns.get(key)
  if (active) {
    return active
  }
  const attempt = terminateOnce(child, deps).catch(
    (): ProviderProcessTeardownVerdict => 'unverifiable'
  )
  activeTeardowns.set(key, attempt)
  void attempt.then(() => {
    if (activeTeardowns.get(key) === attempt) {
      activeTeardowns.delete(key)
    }
  })
  return attempt
}
