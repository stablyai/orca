import type { WindowsProcessCandidate } from './process-rows'

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

/** Windows keeps a dead parent's pid on its orphans and reuses pids, so a direct orphan only belongs
 * to this pane when its creation time is known and after the pane's spawn; others drop with their subtrees. */
export function orphansBornAfterSpawn(
  orphans: WindowsProcessCandidate[],
  paneSpawnedAtMs: number
): WindowsProcessCandidate[] {
  const foreign = new Set<number>()
  for (const orphan of [...orphans].sort((a, b) => a.depth - b.depth)) {
    const unproven =
      orphan.depth === 1 &&
      (orphan.creationTimeMs === undefined || orphan.creationTimeMs < paneSpawnedAtMs)
    if (unproven || foreign.has(orphan.ppid)) {
      foreign.add(orphan.pid)
    }
  }
  return orphans.filter((orphan) => !foreign.has(orphan.pid))
}
