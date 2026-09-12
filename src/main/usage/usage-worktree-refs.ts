import type { Repo } from '../../shared/repo-types'
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
  repos: Repo[],
  worktreesByRepo: Map<string, { path: string; worktreeId: string; displayName: string }[]>
): UsageScanWorktreeRef[] {
  const refs: UsageScanWorktreeRef[] = []
  for (const repo of repos) {
    for (const worktree of worktreesByRepo.get(repo.id) ?? []) {
      refs.push({
        repoId: repo.id,
        worktreeId: worktree.worktreeId,
        path: worktree.path,
        displayName: worktree.displayName
      })
    }
  }
  return refs
}
