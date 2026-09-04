import type { Repo } from '../shared/repo-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { listWorktreeGraph, listWorktrees, listWorktreesStrict } from './git/worktree'
import { isFolderRepo } from '../shared/repo-kind'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import { resolveGitRouteForHost } from './providers/execution-host-provider-dispatch'
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
  // Why: `!repo.connectionId` matched a remote path against a local one for a row that spells its
  // owner only as `executionHostId: 'ssh:<target>'`. Resolve the host instead of reading one field.
  return repos.some(
    (repo) =>
      getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID &&
      areWorktreePathsEqual(repo.path, resolvedTarget)
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
  const route = resolveGitRouteForHost(getRepoExecutionHostId(repo))
  if (route.kind === 'runtime') {
    // A runtime row's `connectionId` names a target in the *server's* namespace, not one this
    // client may dial. Reading it here would answer from a same-named local target.
    throw new WorktreeCatalogUnavailableError(
      `Worktree catalog unavailable for ${repo.path}: host ${route.hostId} is not reachable from this process.`
    )
  }
  if (route.kind === 'ssh') {
    // Why: runtime worktree resolution can run before SSH providers have reattached during startup.
    // Never fall back to local git against a server path, and never report the unreachable host as an
    // empty catalog (#14004) — callers treat a resolved listing as authoritative.
    if (!route.provider) {
      throw new WorktreeCatalogUnavailableError(
        `Worktree catalog unavailable for ${repo.path}: SSH connection "${route.connectionId}" is not connected.`
      )
    }
    return await route.provider.listWorktrees(repo.path)
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
  const route = resolveGitRouteForHost(getRepoExecutionHostId(repo))
  // An unreachable remote host answers `[]` here, unlike listRepoWorktrees above, which throws.
  // Preserved as-is: this call site's callers treat the graph as best-effort. The inconsistency is
  // real but is a separate behavior decision from resolving the host correctly.
  if (route.kind === 'runtime') {
    return []
  }
  if (route.kind === 'ssh') {
    return route.provider ? await route.provider.listWorktrees(repo.path) : []
  }
  return hasLocalRepoWorktreeListOptions(options)
    ? await listWorktreeGraph(repo.path, options)
    : await listWorktreeGraph(repo.path)
}

export async function listLocalRepoWorktreesStrict(
  repo: Repo,
  options?: LocalRepoWorktreeListOptions
): Promise<GitWorktreeInfo[]> {
  if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
    throw new Error('Cannot list worktrees for a remote repository')
  }
  if (isFolderRepo(repo)) {
    return [createFolderWorktree(repo)]
  }
  return hasLocalRepoWorktreeListOptions(options)
    ? await listWorktreesStrict(repo.path, options)
    : await listWorktreesStrict(repo.path)
}
