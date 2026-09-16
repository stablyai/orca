import type { UsageWorktreeRef } from '../usage-worktree-metadata'
import type { UsageScanWorktreeRef } from './usage-provider-contract'

export function getUsageWorktreeFingerprint(
  worktreesByRepo: Map<string, UsageWorktreeRef[]>
): string {
  const rows = [...worktreesByRepo.entries()]
    .flatMap(([repoId, worktrees]) =>
      worktrees.map((worktree) =>
        JSON.stringify({
          repoId,
          worktreeId: worktree.worktreeId,
          path: worktree.path,
          displayName: worktree.displayName
        })
      )
    )
    .sort()
  return JSON.stringify(rows)
}

export function createWorktreeRefs(
  worktreesByRepo: Map<string, { path: string; worktreeId: string; displayName: string }[]>
): UsageScanWorktreeRef[] {
  const refs: UsageScanWorktreeRef[] = []
  // Why: folder workspaces are keyed by a synthetic repo id that `getRepos()` never lists.
  for (const [repoId, worktrees] of worktreesByRepo) {
    for (const worktree of worktrees) {
      refs.push({
        repoId,
        worktreeId: worktree.worktreeId,
        path: worktree.path,
        displayName: worktree.displayName
      })
    }
  }
  return refs
}
