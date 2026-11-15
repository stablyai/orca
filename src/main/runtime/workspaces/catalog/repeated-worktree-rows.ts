import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'

/** Keep Git's first exact id (main checkout first); execution-host path case/alias rules are unknown here (#23631). */
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
