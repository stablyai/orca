import type { GitWorktreeInfo } from '../../shared/types'
import { listWorktreesStrict } from '../git/worktree'
import type { LocalProjectWorktreeGitOptions } from '../project-runtime-git-options'

export type RuntimeWorktreeScanResult =
  | { ok: true; worktrees: GitWorktreeInfo[]; lineageRevision: number | undefined }
  | { ok: false; worktrees: GitWorktreeInfo[] }

export async function scanLocalRepoWorktreesForResolution(
  repoPath: string,
  options: LocalProjectWorktreeGitOptions,
  lineageRevision: number | undefined
): Promise<RuntimeWorktreeScanResult> {
  try {
    const worktrees = options.wslDistro
      ? await listWorktreesStrict(repoPath, options)
      : await listWorktreesStrict(repoPath)
    return { ok: true, worktrees, lineageRevision }
  } catch {
    return { ok: false, worktrees: [] }
  }
}
