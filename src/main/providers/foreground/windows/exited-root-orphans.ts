import type { WindowsProcessCandidate, WindowsProcessRow } from './process-rows'

const CONSOLE_HOST_NAMES = new Set(['conhost.exe', 'openconsole.exe'])

/** A process that opened its own console owns a console host child; one without it kept the console it
 * inherited, which for a direct child of the pane root is the pane's pseudo console. */
export function findOrphanOnInheritedConsole(
  candidates: readonly WindowsProcessCandidate[]
): number | undefined {
  return candidates.find(
    (candidate) =>
      candidate.depth === 1 &&
      !candidates.some(
        (child) => child.ppid === candidate.pid && CONSOLE_HOST_NAMES.has(child.name.toLowerCase())
      )
  )?.pid
}

// Creation times of pane roots seen alive, bounded; the oldest entry is dropped first.
const rootCreationTimes = new Map<number, number>()
const MAX_REMEMBERED_ROOTS = 512

export function rememberPaneRoot(
  row: Pick<WindowsProcessRow, 'pid' | 'creationTimeMs'> | undefined
) {
  if (row?.creationTimeMs === undefined) {
    return
  }
  rootCreationTimes.delete(row.pid)
  rootCreationTimes.set(row.pid, row.creationTimeMs)
  if (rootCreationTimes.size > MAX_REMEMBERED_ROOTS) {
    rootCreationTimes.delete(rootCreationTimes.keys().next().value!)
  }
}

export function forgetPaneRoots(): void {
  rootCreationTimes.clear()
}

/** Windows reuses a dead root's pid: a direct orphan born before the root was seen is a child of an
 * earlier holder of that pid, so it and its subtree are dropped. Unseen roots keep every orphan. */
export function orphansBornAfterRoot(
  rootPid: number,
  orphans: WindowsProcessCandidate[]
): WindowsProcessCandidate[] {
  const rootBorn = rootCreationTimes.get(rootPid)
  if (rootBorn === undefined) {
    return orphans
  }
  const foreign = new Set<number>()
  for (const orphan of [...orphans].sort((a, b) => a.depth - b.depth)) {
    const older = orphan.depth === 1 && (orphan.creationTimeMs ?? rootBorn) < rootBorn
    if (older || foreign.has(orphan.ppid)) {
      foreign.add(orphan.pid)
    }
  }
  return orphans.filter((orphan) => !foreign.has(orphan.pid))
}
