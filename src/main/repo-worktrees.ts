import type { GitWorktreeInfo, Repo } from '../shared/types'
import { listWorktrees } from './git/worktree'
import { isFolderRepo } from '../shared/repo-kind'
import { getSshGitProvider } from './providers/ssh-git-dispatch'

export function createFolderWorktree(repo: Repo): GitWorktreeInfo {
  return {
    path: repo.path,
    head: '',
    branch: '',
    isBare: false,
    // Why: folder mode has no linked worktree graph. Treat the folder itself
    // as the single primary worktree so the rest of Orca's worktree-first UI
    // can keep using one stable workspace identity.
    isMainWorktree: true
  }
}

export async function listRepoWorktrees(repo: Repo): Promise<GitWorktreeInfo[]> {
  if (isFolderRepo(repo)) {
    return [createFolderWorktree(repo)]
  }
  if (repo.connectionId) {
    const provider = getSshGitProvider(repo.connectionId)
    // Why: runtime worktree resolution can run before SSH providers have
    // reattached during startup. Return empty instead of falling back to
    // local git against a server path.
    return provider ? await provider.listWorktrees(repo.path) : []
  }
  return await listWorktrees(repo.path)
}
