import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { listWorktreesStrict } from '../git/worktree'
import type { LocalProjectWorktreeGitOptions } from '../project-runtime-git-options'

export type RuntimeWorktreeScanResult = {
  ok: boolean
  worktrees: GitWorktreeInfo[]
  /** Internal observation currency; never serialized to clients. */
  isCurrent?: () => boolean
}

export async function scanLocalRepoWorktreesForResolution(
  repoPath: string,
  options: LocalProjectWorktreeGitOptions
): Promise<RuntimeWorktreeScanResult> {
  try {
    const worktrees = options.wslDistro
      ? await listWorktreesStrict(repoPath, options)
      : await listWorktreesStrict(repoPath)
    return { ok: true, worktrees }
  } catch {
    return { ok: false, worktrees: [] }
  }
}
