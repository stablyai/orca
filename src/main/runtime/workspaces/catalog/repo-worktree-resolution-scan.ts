import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import {
  isTrueEmptyWorktreeListing,
  listWorktreesStrict
} from '../../../git/worktrees/catalog/worktree-listing'
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
    const worktrees = options.wslDistro
      ? await listWorktreesStrict(repoPath, options)
      : await listWorktreesStrict(repoPath)
    return { ok: true, worktrees }
  } catch (err) {
    return (await isTrueEmptyWorktreeListing(repoPath, err))
      ? { ok: false, worktrees: [], trueEmpty: true }
      : { ok: false, worktrees: [] }
  }
}
