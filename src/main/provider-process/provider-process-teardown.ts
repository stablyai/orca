import type { ChildProcessHandle } from '../../shared/child-process/run-process'
import type { DescendantSnapshot } from '../pty-descendant-termination'
import {
  terminateDescendantSnapshotWithVerdict,
  type DescendantTreeVerdict
} from '../pty-descendant-exit-verification'
import { terminateWindowsProcessTree } from '../windows-process-tree-kill'
import { recordSelfInitiatedTreeKill } from '../crash-reporting/self-initiated-tree-kill-log'
import { killSupervisedProviderGroup } from './provider-supervised-group-kill'

/** What a forced teardown established. */
export type ProviderProcessTeardownVerdict = {
  /** What it observed of the descendants; null when it made no observation. */
  tree: DescendantTreeVerdict | null
  /** The kill reached the provider, the process that writes the conversation: SIGKILL to its own
   *  group on POSIX, TerminateProcess of the root on Windows. Never an observed exit. */
  providerKilled: boolean
}

const activeTeardowns = new WeakMap<object, Promise<ProviderProcessTeardownVerdict>>()

type TeardownChild = Pick<ChildProcessHandle, 'pid' | 'kill'>

export type ProviderProcessTeardownDeps = {
  site: string
  platform?: NodeJS.Platform
  dedicatedProcessGroup?: boolean
  captureDescendants?: (rootPid: number) => Promise<DescendantSnapshot | null>
  terminateDescendants?: (snapshot: DescendantSnapshot) => Promise<DescendantTreeVerdict>
  terminateWindowsTree?: (rootPid: number, deps?: { site?: string }) => Promise<void>
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
    const tree = (error as NodeJS.ErrnoException).code === 'ESRCH' ? null : 'unverifiable'
    return { tree, providerKilled: false }
  }
  // Outside the try: that catch is the ESRCH contract, not a breadcrumb handler.
  recordSelfInitiatedTreeKill({
    pid: rootPid,
    site: deps.site,
    scope: 'posix-process-group'
  })
  // A delivered signal is not an observed exit.
  return { tree: null, providerKilled: true }
}

async function terminatePosixTree(
  child: TeardownChild,
  rootPid: number,
  deps: ProviderProcessTeardownDeps
): Promise<ProviderProcessTeardownVerdict> {
  const forced = await killSupervisedProviderGroup(child, rootPid, {
    site: deps.site,
    ...(deps.captureDescendants ? { captureDescendants: deps.captureDescendants } : {}),
    ...(deps.signalProcessGroup ? { signalProcessGroup: deps.signalProcessGroup } : {})
  })
  if (forced.provider === 'unknown' || !forced.snapshot) {
    // Nothing was killed; the resumed supervisor's own stop is still under way.
    return { tree: null, providerKilled: false }
  }
  // Descendants that left the provider's group are judged by identity from the paused read.
  const terminate =
    deps.terminateDescendants ??
    ((captured: DescendantSnapshot) =>
      terminateDescendantSnapshotWithVerdict(captured, { requireIdentityBeforeSignal: true }))
  return { tree: await terminate(forced.snapshot), providerKilled: true }
}

/** Stops every process owned by one provider launch before releasing its wrapper. */
async function terminateOnce(
  child: TeardownChild,
  deps: ProviderProcessTeardownDeps
): Promise<ProviderProcessTeardownVerdict> {
  const rootPid = child.pid
  if (!rootPid) {
    child.kill('SIGKILL')
    return { tree: 'unverifiable', providerKilled: false }
  }
  if ((deps.platform ?? process.platform) === 'win32') {
    const terminate = deps.terminateWindowsTree ?? terminateWindowsProcessTree
    await terminate(rootPid, { site: deps.site })
    // taskkill owns the tree; TerminateProcess of the root is the provider's own kill, since
    // Windows runs it without a supervisor.
    const providerKilled = child.kill('SIGKILL')
    // taskkill resolves alike on success, failure and timeout, so nothing was observed.
    return { tree: null, providerKilled }
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
  const attempt = terminateOnce(child, deps).catch((): ProviderProcessTeardownVerdict => ({
    tree: 'unverifiable',
    providerKilled: false
  }))
  activeTeardowns.set(key, attempt)
  void attempt.then(() => {
    if (activeTeardowns.get(key) === attempt) {
      activeTeardowns.delete(key)
    }
  })
  return attempt
}
