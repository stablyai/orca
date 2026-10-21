import type { ChildProcessHandle } from '@orca/process-host/process-spec'
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
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void
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
  let verdict: ProviderProcessTeardownVerdict = 'unverifiable'
  try {
    verdict = await terminate(snapshot)
  } finally {
    const signal = deps.signalProcess ?? process.kill
    const signalGroup =
      deps.signalProcessGroup ??
      ((pgid: number, toSend: NodeJS.Signals) => process.kill(-pgid, toSend))
    // The stopped root cannot reap or release its direct children's PIDs. Its snapshot pins
    // their identity until after this root is killed, even if a later table read fails.
    for (const descendant of snapshot.descendants) {
      if (descendant.ppid !== rootPid) {
        continue
      }
      if (descendant.pgid === descendant.pid) {
        try {
          signalGroup(descendant.pid, 'SIGKILL')
        } catch {
          // An already exited group is safe to ignore.
        }
      }
      try {
        signal(descendant.pid, 'SIGKILL')
      } catch {
        // The root still has to be stopped when a child rejects a signal.
      }
    }
    if (snapshot.rootPgid === rootPid) {
      try {
        signalGroup(rootPid, 'SIGKILL')
        recordSelfInitiatedTreeKill({
          pid: rootPid,
          site: deps.site,
          scope: 'posix-process-group'
        })
      } catch {
        // The held root is still addressed through its exact child handle below.
      }
    }
    child.kill('SIGKILL')
  }
  return verdict
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
