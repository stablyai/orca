import type { JobTerminationOutcome } from './windows/windows-pty-job'
import {
  captureDescendantSnapshot,
  killWithDescendantSweep,
  type ProcessTableReader,
  type SignalSender
} from './pty-descendant-termination'
import {
  terminateDescendantSnapshotWithVerdict,
  type DescendantTreeVerdict
} from './pty-descendant-exit-verification'
import {
  captureWindowsDescendantSnapshot,
  verifyWindowsDescendantSnapshotExit,
  type WindowsDescendantVerificationDeps
} from './windows-descendant-exit-verification'
import type { WindowsTreeKiller } from './windows-process-tree-kill'
import type { WindowsTreeKillTarget } from './windows-pty-root-identity'

export type ReapDescendantTreeDeps = {
  platform?: NodeJS.Platform
  readTable?: ProcessTableReader
  sendSignal?: SignalSender
  ownsRoot?: () => boolean
  terminateOwnedTree?: () => JobTerminationOutcome
  killWindowsTree?: WindowsTreeKiller
  verifyTreeKillTarget?: (rootPid: number) => Promise<WindowsTreeKillTarget>
  readWindowsTable?: WindowsDescendantVerificationDeps['readTable']
  graceMs?: number
  verifyMs?: number
  timeoutMs?: number
}

/**
 * Kill a PTY root and its agent/tool descendants, then report whether the tree
 * is actually gone. `exited` is the only success; `live` and `unverifiable` are
 * failures to reap — never treat either as a successful session-killed.
 *
 * POSIX: identity-gated SIGTERM/SIGKILL via the existing verifier (same
 * vocabulary as Claude's child-tree reaper). Windows: job/taskkill sweep, then
 * creation-time verification — taskkill completion is never itself evidence.
 */
export async function reapDescendantTree(
  rootPid: number,
  killRoot: () => void,
  deps: ReapDescendantTreeDeps = {}
): Promise<DescendantTreeVerdict> {
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') {
    const snapshot = await captureWindowsDescendantSnapshot(rootPid, {
      readTable: deps.readWindowsTable
    })
    await killWithDescendantSweep(rootPid, killRoot, {
      platform,
      ownsRoot: deps.ownsRoot,
      terminateOwnedTree: deps.terminateOwnedTree,
      killWindowsTree: deps.killWindowsTree,
      verifyTreeKillTarget: deps.verifyTreeKillTarget
    })
    if (!snapshot) {
      return 'unverifiable'
    }
    return verifyWindowsDescendantSnapshotExit(snapshot, {
      readTable: deps.readWindowsTable,
      verifyMs: deps.verifyMs
    })
  }

  const snapshot = await captureDescendantSnapshot(rootPid, {
    platform,
    readTable: deps.readTable,
    timeoutMs: deps.timeoutMs
  })
  if (!snapshot) {
    killRoot()
    // A missed table is not proof the tree is empty.
    return 'unverifiable'
  }
  if (snapshot.descendants.length === 0) {
    killRoot()
    // A walk with no observed root cannot see descendants that already reparented.
    return snapshot.root ? 'exited' : 'unverifiable'
  }

  // Signal descendants under identity revalidation, then kill the root while
  // verification is already polling — matching the Claude reaper ordering so a
  // stopped parent cannot leave zombies that block the exited verdict.
  const verdictPromise = terminateDescendantSnapshotWithVerdict(snapshot, {
    readTable: deps.readTable,
    sendSignal: deps.sendSignal,
    graceMs: deps.graceMs,
    verifyMs: deps.verifyMs,
    timeoutMs: deps.timeoutMs,
    requireIdentityBeforeSignal: true
  })
  if (deps.ownsRoot?.() ?? true) {
    killRoot()
  }
  return verdictPromise
}
