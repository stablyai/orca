import type { Repo } from '../../shared/repo-types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { getConnectionExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { normalizeGhAccountBinding } from '../../shared/github/account-binding'
import { isGitRepoKind } from '../../shared/repo-kind'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  resolveLocalProjectRuntimesForRepos,
  type ProjectRuntimeResolutionStore
} from '../local-project-runtime-resolution'
import { getStoredRepoExecutionHostId } from '../repo-execution-host'
import type { GitHubRepoContext } from './github-repository-identity'

type AccountStore = ProjectRuntimeResolutionStore & {
  getRepos: () => readonly Repo[]
  getAllWorktreeMetaForHost?: (hostId: ExecutionHostId) => Record<string, unknown>
}
type KnownWorktree = { repoId: string; path: string; hostId?: ExecutionHostId }
let source: { store: AccountStore; worktrees: () => readonly KnownWorktree[] } | null = null

export function installGitHubProjectAccounts(
  store: AccountStore | null,
  worktrees: () => readonly KnownWorktree[] = () => []
): () => void {
  const installed = store ? { store, worktrees } : null
  source = installed
  return () => {
    if (source === installed) {
      source = null
    }
  }
}

function pathKey(path: string, distro?: string): string {
  const unc = parseWslUncPath(path)
  const runtime = (unc?.distro ?? distro)?.toLowerCase() ?? ''
  return `${runtime}\0${normalizeRuntimePathForComparison(unc?.linuxPath ?? path)}`
}

/** A recognized unbound project differs from a path with no known owner. */
export function resolveGitHubProjectAccount(context: GitHubRepoContext) {
  if (!source) {
    return null
  }
  const { store, worktrees } = source
  const hostId = getConnectionExecutionHostId(context.connectionId)
  const key = pathKey(context.repoPath, context.connectionId ? undefined : context.wslDistro)
  const repos = store
    .getRepos()
    .filter((repo) => isGitRepoKind(repo) && getStoredRepoExecutionHostId(repo) === hostId)
  const runtimes = resolveLocalProjectRuntimesForRepos(store, repos)
  const reposById = new Map(repos.map((repo) => [repo.id, repo]))
  const repoDistro = (repo: Repo): string | undefined => {
    if (context.connectionId) {
      return undefined
    }
    const runtime = runtimes.get(repo.id)
    return runtime?.status === 'resolved' && runtime.runtime.kind === 'wsl'
      ? runtime.runtime.distro
      : parseWslUncPath(repo.path)?.distro
  }
  let matches = repos.filter((repo) => pathKey(repo.path, repoDistro(repo)) === key)
  if (!matches.length) {
    const owners = new Set<string>()
    for (const worktree of worktrees()) {
      const repo = reposById.get(worktree.repoId)
      if (
        repo &&
        getStoredRepoExecutionHostId({ executionHostId: worktree.hostId }) === hostId &&
        pathKey(worktree.path, repoDistro(repo)) === key
      ) {
        owners.add(repo.id)
      }
    }
    // Persisted workspace identities cover cold starts without starting a Git scan.
    for (const id of Object.keys(store.getAllWorktreeMetaForHost?.(hostId) ?? {})) {
      const parsed = splitWorktreeIdForFilesystem(id)
      const repo = parsed && reposById.get(parsed.repoId)
      if (repo && parsed && pathKey(parsed.worktreePath, repoDistro(repo)) === key) {
        owners.add(repo.id)
      }
    }
    matches = repos.filter((repo) => owners.has(repo.id))
  }
  return matches.length === 1
    ? { ghAccount: normalizeGhAccountBinding(matches[0].ghAccount) ?? undefined }
    : null
}
