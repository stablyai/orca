import {
  captureDescendantSnapshot,
  killWithDescendantSweep,
  sendDescendantSignal,
  type DescendantSnapshot,
  type ProcessTableRow,
  type SignalSender
} from './pty-descendant-termination'
import { terminateDescendantSnapshotWithVerdict } from './pty-descendant-exit-verification'

export type FinishedSessionTreeKillDeps = {
  killWithDescendantSweep?: typeof killWithDescendantSweep
  captureDescendantSnapshot?: typeof captureDescendantSnapshot
  terminateDescendantSnapshotWithVerdict?: typeof terminateDescendantSnapshotWithVerdict
  sendSignal?: SignalSender
  platform?: NodeJS.Platform
}

export type FinishedSessionTreeKillResult = {
  livePids: number[]
}

function usableRootPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1 && pid !== process.pid
}

/**
 * SIGTERM the session tree, then SIGKILL whatever is still the same process.
 * POSIX proof goes through the existing snapshot verdict. Windows goes through
 * killWithDescendantSweep, which already owns the job object and taskkill path.
 */
export async function forceKillFinishedWorktreeSessionTree(
  rootPids: readonly number[],
  deps: FinishedSessionTreeKillDeps = {}
): Promise<FinishedSessionTreeKillResult> {
  const killTree = deps.killWithDescendantSweep ?? killWithDescendantSweep
  const capture = deps.captureDescendantSnapshot ?? captureDescendantSnapshot
  const terminate =
    deps.terminateDescendantSnapshotWithVerdict ?? terminateDescendantSnapshotWithVerdict
  const sendSignal = deps.sendSignal ?? sendDescendantSignal
  const platform = deps.platform ?? process.platform
  const livePids: number[] = []
  const seen = new Set<number>()

  for (const pid of rootPids) {
    if (!usableRootPid(pid) || seen.has(pid)) {
      continue
    }
    seen.add(pid)
    const snapshot = await capture(pid, deps)
    await killTree(pid, () => sendSignal(pid, 'SIGTERM'), {
      ...deps,
      platform
    })
    if (!snapshot?.root || platform === 'win32') {
      continue
    }
    const verdict = await terminate(snapshotWithRoot(snapshot, pid), {
      ...deps,
      sendSignal
    })
    if (verdict === 'live') {
      livePids.push(pid)
    }
  }

  return { livePids }
}

function snapshotWithRoot(snapshot: DescendantSnapshot, pid: number): DescendantSnapshot {
  const rootRow: ProcessTableRow = {
    pid,
    ppid: 0,
    pgid: snapshot.rootPgid ?? pid,
    startedAt: snapshot.root?.startedAt ?? ''
  }
  return {
    ...snapshot,
    descendants: [rootRow, ...snapshot.descendants.filter((row) => row.pid !== pid)]
  }
}
