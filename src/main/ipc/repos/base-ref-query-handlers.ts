import { ipcMain } from 'electron'
import type { Store } from '../../persistence'
import type { BaseRefDefaultResult, BaseRefSearchResult, Repo } from '../../../shared/repo-types'
import {
  clampRepoSearchRefsLimit,
  REPO_SEARCH_REFS_DEFAULT_LIMIT,
  isRepoSearchRefsRequestLimit
} from '../../../shared/repo-search-limits'
import { isFolderRepo } from '../../../shared/repo-kind'
import {
  getRepoExecutionHostId,
  getRepoRoutingConnectionId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getBaseRefDefault, getRemoteCount, searchBaseRefDetails } from '../../git/repo'
import { resolveWorktreeBroadFetchRemoteName } from '../../../shared/worktree-broad-fetch-remote'
import { getProjectRuntimeReadGitOptions } from '../../project-runtime-git-options'
import { blockedWslDistroForPath } from '../../wsl/wsl-unc-access-gate'
import { broadcastWhenWslDistroRunning } from '../preflight-wsl-refusal-retry'

export type BaseRefQueryRuntime = {
  /** Best-effort `git fetch <remote>` with the runtime remote-fetch cache (local native only). */
  fetchRemoteWithCache: (repoPath: string, remote: string) => Promise<void>
}

export function registerBaseRefQueryHandlers(store: Store, runtime?: BaseRefQueryRuntime): void {
  ipcMain.handle(
    'repos:getBaseRefDefault',
    async (
      _event,
      args: { repoId: string; hostId?: ExecutionHostId }
    ): Promise<BaseRefDefaultResult> => {
      const repo = getRepoForExecutionHost(store, args.repoId, args.hostId)
      if (!repo || isFolderRepo(repo)) {
        // Folder projects have no Git base ref; null prevents a fabricated renderer default.
        return { defaultBaseRef: null, remoteCount: 0 }
      }
      // SSH Git state is unavailable to this local handler.
      if (getRepoRoutingConnectionId(repo)) {
        return { defaultBaseRef: null, remoteCount: 0 }
      }
      // Where the project's runtime runs Git; a runtime needing repair reads with host Git.
      const git = getProjectRuntimeReadGitOptions(store, repo)
      // Opening Settings must not start a stopped distro (E9); the renderer re-asks once it runs.
      const blocked = await blockedWslDistroForPath(repo.path, git.wslDistro)
      if (blocked) {
        broadcastWhenWslDistroRunning(blocked.distro, `base-ref-default:${repo.id}`)
        return { defaultBaseRef: null, remoteCount: 0, refusedWslDistro: blocked.distro }
      }
      const [defaultBaseRef, remoteCount] = await Promise.all([
        getBaseRefDefault(repo.path, git),
        getRemoteCount(repo.path, git)
      ])
      return { defaultBaseRef, remoteCount }
    }
  )

  ipcMain.handle(
    'repos:searchBaseRefs',
    async (
      _event,
      args: { repoId: string; query: string; limit?: number; hostId?: ExecutionHostId }
    ) => {
      return (await searchBaseRefDetailsForRepo(store, args, runtime)).map((entry) => entry.refName)
    }
  )

  ipcMain.handle(
    'repos:searchBaseRefDetails',
    async (
      _event,
      args: { repoId: string; query: string; limit?: number; hostId?: ExecutionHostId }
    ) => {
      return searchBaseRefDetailsForRepo(store, args, runtime)
    }
  )
}

async function searchBaseRefDetailsForRepo(
  store: Store,
  args: { repoId: string; query: string; limit?: number; hostId?: ExecutionHostId },
  runtime?: BaseRefQueryRuntime
): Promise<BaseRefSearchResult[]> {
  const repo = getRepoForExecutionHost(store, args.repoId, args.hostId)
  if (!repo || isFolderRepo(repo)) {
    return []
  }
  const requestedLimit = args.limit ?? REPO_SEARCH_REFS_DEFAULT_LIMIT
  if (!isRepoSearchRefsRequestLimit(requestedLimit)) {
    return []
  }
  // Bound Git work and retained results while accepting oversized IPC page requests.
  const limit = clampRepoSearchRefsLimit(requestedLimit)
  if (getRepoRoutingConnectionId(repo)) {
    return []
  }
  // The picker only sees local remote-tracking refs. Fetch the canonical remote first.
  if (runtime) {
    try {
      await runtime.fetchRemoteWithCache(repo.path, resolveWorktreeBroadFetchRemoteName(repo))
    } catch {
      // Offline or auth failures must not block listing the local refs we already have.
    }
  }
  return searchBaseRefDetails(
    repo.path,
    args.query,
    limit,
    true,
    getProjectRuntimeReadGitOptions(store, repo)
  )
}

function getRepoForExecutionHost(
  store: Store,
  repoId: string,
  hostId?: ExecutionHostId
): Repo | null {
  if (!hostId) {
    return store.getRepo(repoId) ?? null
  }
  // Repo IDs can collide across hosts; read the host selected for the corresponding write.
  return (
    store
      .getRepos()
      .find((repo) => repo.id === repoId && getRepoExecutionHostId(repo) === hostId) ?? null
  )
}
