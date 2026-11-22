import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import { listWorktreesSharedStrictAllowingTrueEmpty } from '../../../git/worktrees/catalog/worktree-scan-cache'
import type { LocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'

export type RuntimeWorktreeScanResult =
  | { ok: true; worktrees: GitWorktreeInfo[] }
  | { ok: false; worktrees: GitWorktreeInfo[]; trueEmpty?: boolean }

/** Runtime readers never treat an empty catalog as success; `trueEmpty` tells the shared owner it was confirmed. */
export async function scanLocalRepoWorktreesForResolution(
  repoPath: string,
  options: LocalProjectWorktreeGitOptions
): Promise<RuntimeWorktreeScanResult> {
  try {
    // Equivalent requests from other registrations of this path join one Git process.
    const worktrees = options.wslDistro
      ? await listWorktreesSharedStrictAllowingTrueEmpty(repoPath, options)
      : await listWorktreesSharedStrictAllowingTrueEmpty(repoPath)
    return worktrees.length > 0
      ? { ok: true, worktrees }
      : { ok: false, worktrees: [], trueEmpty: true }
  } catch {
    return { ok: false, worktrees: [] }
  }
}
