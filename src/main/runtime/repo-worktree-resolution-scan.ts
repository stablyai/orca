import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { listWorktreesFromMembershipStrict } from '../git/worktree'
import type { LocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { RESOLVED_WORKTREE_REPO_TIMEOUT_MS } from './repo-worktree-row-resolution'

export type RuntimeWorktreeScanResult =
  | { ok: true; worktrees: GitWorktreeInfo[] }
  | { ok: false; worktrees: GitWorktreeInfo[] }

export async function scanLocalRepoWorktreesForResolution(
  repoPath: string,
  options: LocalProjectWorktreeGitOptions
): Promise<RuntimeWorktreeScanResult> {
  try {
    // Resolution gives up on a repo after this long, so waiting longer on a stalled model is waste.
    const worktrees = await listWorktreesFromMembershipStrict(repoPath, {
      ...options,
      waitMs: RESOLVED_WORKTREE_REPO_TIMEOUT_MS
    })
    return { ok: true, worktrees }
  } catch {
    return { ok: false, worktrees: [] }
  }
}
