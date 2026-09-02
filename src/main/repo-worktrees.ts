import type { Repo } from '../shared/repo-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { listWorktreeGraph, listWorktrees, listWorktreesStrict } from './git/worktree'
import { isFolderRepo } from '../shared/repo-kind'
import { getSshGitProvider } from './providers/ssh-git-dispatch'
import { areWorktreePathsEqual } from './ipc/worktree-logic'
import { WorktreeCatalogUnavailableError } from '../shared/worktree/worktree-catalog-availability'

type LocalRepoWorktreeListOptions = {
  wslDistro?: string
  signal?: AbortSignal
}

function hasLocalRepoWorktreeListOptions(options: LocalRepoWorktreeListOptions | undefined) {
  return options?.wslDistro !== undefined || options?.signal !== undefined
}

export function isRepoRoot(repos: Repo[], resolvedTarget: string): boolean {
  return repos.some(
    (repo) => !repo.connectionId && areWorktreePathsEqual(repo.path, resolvedTarget)
  )
}

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

export async function listRepoWorktrees(
  repo: Repo,
  options?: LocalRepoWorktreeListOptions
): Promise<GitWorktreeInfo[]> {
  if (isFolderRepo(repo)) {
    return [createFolderWorktree(repo)]
  }
  if (repo.connectionId) {
    const provider = getSshGitProvider(repo.connectionId)
    // Why: runtime worktree resolution can run before SSH providers have reattached during startup.
    // Never fall back to local git against a server path, and never report the unreachable host as an
    // empty catalog (#14004) — callers treat a resolved listing as authoritative.
    if (!provider) {
      throw new WorktreeCatalogUnavailableError(
        `Worktree catalog unavailable for ${repo.path}: SSH connection "${repo.connectionId}" is not connected.`
      )
    }
    return await provider.listWorktrees(repo.path)
  }
  return hasLocalRepoWorktreeListOptions(options)
    ? await listWorktrees(repo.path, options)
    : await listWorktrees(repo.path)
}

/**
 * Worktree rows for callers that read only `worktree.path`.
 *
 * Skips the sparse-checkout probe behind the badge, which those callers discard. On a WSL repo the
 * probe is a 9p stat plus a config read per worktree, re-paid cold after every worktree
 * create/remove because that invalidates both the authorized-roots cache and the sparse cache.
 */
export async function listRepoWorktreeGraph(
  repo: Repo,
  options?: LocalRepoWorktreeListOptions
): Promise<GitWorktreeInfo[]> {
  if (isFolderRepo(repo)) {
    return [createFolderWorktree(repo)]
  }
  if (repo.connectionId) {
    const provider = getSshGitProvider(repo.connectionId)
    return provider ? await provider.listWorktrees(repo.path) : []
  }
  return hasLocalRepoWorktreeListOptions(options)
    ? await listWorktreeGraph(repo.path, options)
    : await listWorktreeGraph(repo.path)
}

export async function listLocalRepoWorktreesStrict(
  repo: Repo,
  options?: LocalRepoWorktreeListOptions
): Promise<GitWorktreeInfo[]> {
  if (repo.connectionId) {
    throw new Error('Cannot list worktrees for a remote repository')
  }
  if (isFolderRepo(repo)) {
    return [createFolderWorktree(repo)]
  }
  return hasLocalRepoWorktreeListOptions(options)
    ? await listWorktreesStrict(repo.path, options)
    : await listWorktreesStrict(repo.path)
}
