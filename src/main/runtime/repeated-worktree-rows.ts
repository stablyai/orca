import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'

/**
 * One row per worktree id: git lists a path once per registration, so a stale one naming a live
 * checkout repeats it and two rows share one id (#23631). Keep git's first row, as the desktop
 * listing does: git prints the main checkout first, and `git worktree prune` drops a registration
 * naming it as a "duplicate entry"; repeats of a linked path keep git's order. Exact match only:
 * the paths belong to the execution host, whose case and alias rules this process cannot assume.
 */
export function dropRepeatedWorktreeRows(
  scan: RuntimeWorktreeScanResult
): RuntimeWorktreeScanResult {
  const seenPaths = new Set<string>()
  const worktrees = scan.worktrees.filter((worktree) => {
    if (seenPaths.has(worktree.path)) {
      return false
    }
    seenPaths.add(worktree.path)
    return true
  })
  return worktrees.length === scan.worktrees.length ? scan : { ...scan, worktrees }
}
