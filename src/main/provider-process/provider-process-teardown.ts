import type { ProviderChild } from './provider-child'
import {
  captureDescendantSnapshot,
  sendDescendantSignal,
  type DescendantSnapshot
} from '../pty/process-retirement/pty-descendant-termination'
import {
  terminateDescendantSnapshotWithVerdict,
  type DescendantTreeVerdict
} from '../pty/process-retirement/pty-descendant-exit-verification'
import { terminateWindowsProcessTree } from '../pty/process-retirement/windows-process-tree-kill'
import { recordSelfInitiatedTreeKill } from '../crash-reporting/process-exits/self-initiated-tree-kill-log'
import { hasErrorCode } from '../daemon/endpoint/identity/daemon-process-inspection'

/** What the teardown observed of the descendants; null when it signalled but observed nothing. */
export type ProviderProcessTeardownVerdict =
  | DescendantTreeVerdict
  | null
  | { tree: DescendantTreeVerdict | null; killDelivered: true }

const activeTeardowns = new WeakMap<object, Promise<ProviderProcessTeardownVerdict>>()

type TeardownChild = Pick<
  ProviderChild,
  'pid' | 'kill' | 'leaderExited' | 'writerPid' | 'groupVerdict' | 'numericIdentityRetired'
>

export type ProviderProcessTeardownDeps = {
  site: string
  platform?: NodeJS.Platform
  dedicatedProcessGroup?: boolean
  supervised?: boolean
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
    return hasErrorCode(error, 'ESRCH') ? null : 'unverifiable'
  }
  // Keep breadcrumb failures outside the signal-error catch so they cannot be mistaken for ESRCH.
  recordSelfInitiatedTreeKill({
    pid: rootPid,
    site: deps.site,
    scope: 'posix-process-group'
  })
  // A delivered signal is not an observed exit.
  return { tree: null, killDelivered: true }
}

/** Native handles address the writer; a compatibility supervisor needs its held child group. */
export function killProviderWriter(
  child: TeardownChild,
  snapshot: DescendantSnapshot | null,
  deps: Pick<ProviderProcessTeardownDeps, 'supervised' | 'signalProcessGroup'>
): boolean {
  if (!deps.supervised || child.writerPid === child.pid) {
    return child.kill('SIGKILL')
  }
  const signalGroup =
    deps.signalProcessGroup ??
    ((pgid: number, signal: NodeJS.Signals) => process.kill(-pgid, signal))
  let delivered = false
  for (const descendant of snapshot?.descendants ?? []) {
    if (descendant.ppid === child.pid && descendant.pgid === descendant.pid) {
      try {
        signalGroup(descendant.pid, 'SIGKILL')
        delivered = true
      } catch {}
    }
  }
  return delivered
}

async function terminatePosixTree(
  child: TeardownChild,
  rootPid: number,
  deps: ProviderProcessTeardownDeps
): Promise<ProviderProcessTeardownVerdict> {
  const retired = (): boolean =>
    child.numericIdentityRetired === true ||
    child.leaderExited === true ||
    child.groupVerdict === 'exited'
  if (!child.kill('SIGSTOP')) {
    return child.kill('SIGKILL') ? { tree: null, killDelivered: true } : null
  }
  const capture = deps.captureDescendants ?? captureDescendantSnapshot
  const snapshot = await capture(rootPid).catch(() => null)
  if (retired()) {
    return null
  }
  if (!snapshot) {
    // Preserve Codex compatibility: missing snapshot is no observation (null), not an unverifiable verdict.
    const delivered = killProviderWriter(child, null, deps)
    if (deps.supervised && child.writerPid !== child.pid) {
      child.kill('SIGKILL')
    }
    return delivered ? { tree: null, killDelivered: true } : null
  }
  const terminate =
    deps.terminateDescendants ??
    ((captured: DescendantSnapshot) =>
      terminateDescendantSnapshotWithVerdict(captured, {
        sendSignal: (pid, signal) => {
          if (retired()) {
            throw new Error('Provider process identity retired during teardown')
          }
          return sendDescendantSignal(pid, signal)
        }
      }))
  let verdict: DescendantTreeVerdict = 'unverifiable'
  let killDelivered = false
  try {
    verdict = await terminate(snapshot)
  } catch {
    // Descendant observation cannot undo a delivered writer kill.
  }
  if (!retired()) {
    const signal = deps.signalProcess ?? process.kill
    const signalGroup =
      deps.signalProcessGroup ??
      ((pgid: number, toSend: NodeJS.Signals) => process.kill(-pgid, toSend))
    // SIGSTOP prevents the root reaping direct children, pinning their PIDs even if later table reads fail.
    for (const descendant of snapshot.descendants) {
      if (descendant.ppid !== rootPid) {
        continue
      }
      if (descendant.pgid === descendant.pid) {
        try {
          signalGroup(descendant.pid, 'SIGKILL')
        } catch {
          // Group-signalling failure must not skip the exact child and root kill attempts.
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
    try {
      killDelivered = killProviderWriter(child, snapshot, deps)
      if (deps.supervised && child.writerPid !== child.pid) {
        child.kill('SIGKILL')
      }
    } catch {
      // A wrapper failure cannot undo termination of its writer.
    }
  }
  return killDelivered ? { tree: verdict, killDelivered: true } : verdict
}

/** Attempt tree termination; callers must inspect the verdict before claiming descendant exit. */
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
    // Always stop the held root, even when taskkill fails.
    try {
      child.kill('SIGKILL')
    } catch {
      // Exact-root cleanup cannot retract successful tree termination.
    }
    // The root may be a cmd.exe shim, so only taskkill proves the writer was terminated.
    return treeTerminated ? { tree: 'exited', killDelivered: true } : 'unverifiable'
  }
  // Group absence retires the numeric writer even if its actual wait status was lost.
  if (child.groupVerdict === 'exited') {
    return null
  }
  if (child.numericIdentityRetired || child.leaderExited) {
    const delivered = child.kill('SIGKILL')
    return delivered ? { tree: null, killDelivered: true } : null
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
