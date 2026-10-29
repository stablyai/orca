import { preserveFolderUpgradeWorktreePath } from './folder-upgrade-worktree-path'
import type { Repo } from '../shared/repo-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import {
  listWorktreeGraph,
  listWorktrees,
  listWorktreesSharedStrictAllowingTrueEmpty,
  listWorktreesStrict
} from './git/worktree'
import { isFolderRepo } from '../shared/repo-kind'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import { resolveGitRouteForHost } from './providers/execution-host-provider-dispatch'
import { areWorktreePathsEqual } from './git/worktree-path-comparison'
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
    // Folder workspaces use the folder itself as their sole primary worktree.
    isMainWorktree: true
  }
}

export async function listRepoWorktrees(
  repo: Repo,
  options?: LocalRepoWorktreeListOptions
): Promise<GitWorktreeInfo[]> {
  return listRoutedRepoWorktrees(repo, options, listWorktrees)
}

// A failed scan must reject: an authoritative empty list would prune live worktrees.
export async function listRepoWorktreesForDetectedScan(
  repo: Repo,
  options?: LocalRepoWorktreeListOptions
): Promise<GitWorktreeInfo[]> {
  return listRoutedRepoWorktrees(repo, options, listWorktreesSharedStrictAllowingTrueEmpty)
}

function assertLocalGitRoute(repo: Repo): void {
  const route = resolveGitRouteForHost(getRepoExecutionHostId(repo))
  if (route.kind === 'runtime') {
    // Nested runtime SSH targets belong to the server's namespace.
    throw new WorktreeCatalogUnavailableError(
      `Worktree catalog unavailable for ${repo.path}: host ${route.hostId} is not reachable from this process.`
    )
  }
  if (route.kind === 'ssh') {
    // An unreachable host is not an empty catalog; callers would prune live worktrees.
    throw new WorktreeCatalogUnavailableError(
      `Worktree catalog unavailable for ${repo.path}: SSH connection "${route.connectionId}" is not connected.`
    )
  }
}

async function listRoutedRepoWorktrees(
  repo: Repo,
  options: LocalRepoWorktreeListOptions | undefined,
  listLocal: (
    repoPath: string,
    options?: LocalRepoWorktreeListOptions
  ) => Promise<GitWorktreeInfo[]>
): Promise<GitWorktreeInfo[]> {
  if (isFolderRepo(repo)) {
    return [createFolderWorktree(repo)]
  }
  assertLocalGitRoute(repo)
  const worktrees = hasLocalRepoWorktreeListOptions(options)
    ? await listLocal(repo.path, options)
    : await listLocal(repo.path)
  return preserveFolderUpgradeWorktreePath(repo, worktrees)
}

// Path-only callers skip the expensive per-worktree sparse-checkout probe.
export async function listRepoWorktreeGraph(
  repo: Repo,
  options?: LocalRepoWorktreeListOptions
): Promise<GitWorktreeInfo[]> {
  if (isFolderRepo(repo)) {
    return [createFolderWorktree(repo)]
  }
  assertLocalGitRoute(repo)
  const worktrees = hasLocalRepoWorktreeListOptions(options)
    ? await listWorktreeGraph(repo.path, options)
    : await listWorktreeGraph(repo.path)
  return preserveFolderUpgradeWorktreePath(repo, worktrees)
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
  const worktrees = hasLocalRepoWorktreeListOptions(options)
    ? await listWorktreesStrict(repo.path, options)
    : await listWorktreesStrict(repo.path)
  return preserveFolderUpgradeWorktreePath(repo, worktrees)
}
