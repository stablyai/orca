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

export function registerBaseRefQueryHandlers(store: Store): void {
  ipcMain.handle(
    'repos:getBaseRefDefault',
    async (
      _event,
      args: { repoId: string; hostId?: ExecutionHostId }
    ): Promise<BaseRefDefaultResult> => {
      const repo = getRepoForExecutionHost(store, args.repoId, args.hostId)
      if (!repo || isFolderRepo(repo)) {
        // Why: folder repos have no git state for a base ref; return null + 0 so the renderer skips a fabricated default.
        return { defaultBaseRef: null, remoteCount: 0 }
      }
      // Why: an SSH repo's git data lives on a host this process does not serve.
      if (getRepoRoutingConnectionId(repo)) {
        return { defaultBaseRef: null, remoteCount: 0 }
      }
      // Why: run in parallel; a remote-count failure must not break default detection.
      const [defaultBaseRef, remoteCount] = await Promise.all([
        getBaseRefDefault(repo.path),
        getRemoteCount(repo.path)
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
      return (await searchBaseRefDetailsForRepo(store, args)).map((entry) => entry.refName)
    }
  )

  ipcMain.handle(
    'repos:searchBaseRefDetails',
    async (
      _event,
      args: { repoId: string; query: string; limit?: number; hostId?: ExecutionHostId }
    ) => {
      return searchBaseRefDetailsForRepo(store, args)
    }
  )
}

async function searchBaseRefDetailsForRepo(
  store: Store,
  args: { repoId: string; query: string; limit?: number; hostId?: ExecutionHostId }
): Promise<BaseRefSearchResult[]> {
  const repo = getRepoForExecutionHost(store, args.repoId, args.hostId)
  if (!repo || isFolderRepo(repo)) {
    return []
  }
  const requestedLimit = args.limit ?? REPO_SEARCH_REFS_DEFAULT_LIMIT
  if (!isRepoSearchRefsRequestLimit(requestedLimit)) {
    return []
  }
  // Keep the public IPC shape forgiving while bounding Git and retained results
  // for callers that request an unusually large page.
  const limit = clampRepoSearchRefsLimit(requestedLimit)
  if (getRepoRoutingConnectionId(repo)) {
    return []
  }
  return searchBaseRefDetails(repo.path, args.query, limit)
}

function getRepoForExecutionHost(
  store: Store,
  repoId: string,
  hostId?: ExecutionHostId
): Repo | null {
  if (!hostId) {
    return store.getRepo(repoId) ?? null
  }
  // Why: repo ids can collide across local and SSH hosts; read must use the same host the Settings pane selected for the write.
  return (
    store
      .getRepos()
      .find((repo) => repo.id === repoId && getRepoExecutionHostId(repo) === hostId) ?? null
  )
}
