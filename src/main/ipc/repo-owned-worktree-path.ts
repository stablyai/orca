import { posix, resolve } from 'node:path'
import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence'
import { listRepoWorktreeGraph } from '../repo-worktrees'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { getRepoSshConnectionId } from '../../shared/execution-host'
import { resolveRegisteredWorktreePath } from './registered-worktree-roots-cache'

/**
 * Authorize a caller-supplied worktree path against one repo.
 *
 * Why both checks: `resolveRegisteredWorktreePath` only proves the path is a
 * worktree Orca knows about, not that it belongs to `repo`. Without the second
 * step a caller can pair one repo's configuration with another repo's worktree.
 */
export async function resolveRepoOwnedWorktreePath(
  repo: Repo,
  store: Store,
  worktreePath?: string
): Promise<string> {
  if (!worktreePath) {
    return repo.path
  }
  if (getRepoSshConnectionId(repo)) {
    const remoteWorktreePath = normalizeRemoteWorktreePath(worktreePath)
    const repoWorktrees = await listRepoWorktreeGraph(repo)
    if (
      !repoWorktrees.some(
        (worktree) => normalizeRemoteWorktreePath(worktree.path) === remoteWorktreePath
      )
    ) {
      throw new Error('Access denied: worktree does not belong to repository')
    }
    return remoteWorktreePath
  }
  const resolvedWorktreePath = await resolveRegisteredWorktreePath(worktreePath, store)
  const localGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  const repoWorktrees =
    Object.keys(localGitOptions).length > 0
      ? await listRepoWorktreeGraph(repo, localGitOptions)
      : await listRepoWorktreeGraph(repo)
  if (!repoWorktrees.some((worktree) => resolve(worktree.path) === resolvedWorktreePath)) {
    throw new Error('Access denied: worktree does not belong to repository')
  }
  return resolvedWorktreePath
}

export function normalizeRemoteWorktreePath(remotePath: string): string {
  if (!remotePath || remotePath.includes('\0')) {
    throw new Error('Access denied: invalid worktree path')
  }
  // Why: SSH worktree paths belong to the remote POSIX host. Local path.resolve
  // rewrites them on Windows and cannot authorize remote-only paths.
  const normalized = posix.normalize(remotePath)
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}
