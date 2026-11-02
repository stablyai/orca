import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { listWorktreesStrict } from '../git/worktree'
import type { LocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { markProjectCheckout } from '../project-realpath-identity'

export type RuntimeWorktreeScanResult =
  | { ok: true; worktrees: GitWorktreeInfo[] }
  | { ok: false; worktrees: GitWorktreeInfo[] }

export async function scanLocalRepoWorktreesForResolution(
  repoPath: string,
  options: LocalProjectWorktreeGitOptions,
  checkoutRoot: Promise<string | null> | null = null
): Promise<RuntimeWorktreeScanResult> {
  try {
    const worktrees = options.wslDistro
      ? await listWorktreesStrict(repoPath, options)
      : await listWorktreesStrict(repoPath)
    return { ok: true, worktrees: markProjectCheckout(repoPath, worktrees, await checkoutRoot) }
  } catch {
    return { ok: false, worktrees: [] }
  }
}
