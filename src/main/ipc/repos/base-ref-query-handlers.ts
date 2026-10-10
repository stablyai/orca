import { ipcMain } from 'electron'
import type { Store } from '../../persistence'
import type { BaseRefDefaultResult, BaseRefSearchResult, Repo } from '../../../shared/repo-types'
import {
  clampRepoSearchRefsLimit,
  REPO_SEARCH_REFS_DEFAULT_LIMIT,
  isRepoSearchRefsRequestLimit
} from '../../../shared/repo-search-limits'
import { isFolderRepo } from '../../../shared/repo-kind'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import {
  getBaseRefDefault,
  getRemoteCount,
  normalizeRefSearchQuery,
  parseAndFilterSearchRefDetails,
  parseRemoteCount,
  resolveDefaultBaseRefViaExec,
  buildSearchBaseRefsArgv,
  isForEachRefExcludeUnsupportedError,
  mergeBaseRefSearchResultGroups,
  searchBaseRefDetails
} from '../../git/repo'
import { getSshGitProvider } from '../../providers/ssh-git-dispatch'
import { getSshGitCapabilityCache } from '../../git/git-capability-state'

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
      // Why: remote repos need the relay to resolve symbolic-ref where the git data lives.
      if (repo.connectionId) {
        const provider = getSshGitProvider(repo.connectionId)
        if (!provider) {
          return { defaultBaseRef: null, remoteCount: 0 }
        }
        // Why: delegate to shared resolveDefaultBaseRefViaExec; log symbolic-ref failures here to keep the SSH transport diagnostic it otherwise swallows.
        const resolveDefault = async (): Promise<string | null> => {
          return resolveDefaultBaseRefViaExec(async (argv) => {
            try {
              return await provider.exec(argv, repo.path)
            } catch (err) {
              if (argv[0] === 'symbolic-ref') {
                console.warn('[repos:getBaseRefDefault] SSH symbolic-ref failed', {
                  path: repo.path,
                  err
                })
              }
              throw err
            }
          })
        }

        const resolveRemoteCount = async (): Promise<number> => {
          try {
            const remotesResult = await provider.exec(['remote'], repo.path)
            return parseRemoteCount(remotesResult.stdout)
          } catch (err) {
            // Why: 0 = unknown sentinel that suppresses the multi-remote hint.
            console.warn('[repos:getBaseRefDefault] SSH git remote count failed', {
              path: repo.path,
              err
            })
            return 0
          }
        }

        const [defaultBaseRef, remoteCount] = await Promise.all([
          resolveDefault(),
          resolveRemoteCount()
        ])
        return { defaultBaseRef, remoteCount }
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
  // Why: remote repos need the relay to list branches on the remote host.
  if (repo.connectionId) {
    const provider = getSshGitProvider(repo.connectionId)
    if (!provider) {
      return []
    }
    // Why: strip glob metacharacters to prevent glob injection (mirrors local normalizeRefSearchQuery).
    const normalizedQuery = normalizeRefSearchQuery(args.query)
    try {
      // Why: argv lives in buildSearchBaseRefsArgv so SSH and local paths cannot drift.
      const remotesResult = await provider.exec(['remote'], repo.path).catch(() => ({ stdout: '' }))
      const remotes = remotesResult.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      const capabilities = getSshGitCapabilityCache(provider)
      const runSearch = async (patternGroup?: 'segmented' | 'branchRoot'): Promise<string> => {
        return capabilities.runWithFallback(
          'for-each-ref-exclude',
          async () =>
            (
              await provider.exec(
                buildSearchBaseRefsArgv(normalizedQuery, limit, {
                  remoteNames: remotes,
                  patternGroup
                }),
                repo.path
              )
            ).stdout,
          async () =>
            (
              await provider.exec(
                buildSearchBaseRefsArgv(normalizedQuery, limit, {
                  excludeRemoteHead: false,
                  remoteNames: remotes,
                  patternGroup
                }),
                repo.path
              )
            ).stdout,
          isForEachRefExcludeUnsupportedError
        )
      }
      // Why: delegate the parse/filter/dedup/limit pipeline to the shared helper so SSH and local paths cannot diverge.
      const searchTokens = normalizedQuery.split('/').filter((token) => token.length > 0)
      if (searchTokens.length > 1) {
        const results = await Promise.all([runSearch('segmented'), runSearch('branchRoot')])
        return mergeBaseRefSearchResultGroups(
          results.map((stdout) => parseAndFilterSearchRefDetails(stdout, limit, remotes)),
          limit
        )
      }
      return parseAndFilterSearchRefDetails(await runSearch(), limit, remotes)
    } catch (err) {
      console.warn('[repos:searchBaseRefs] SSH for-each-ref failed', {
        path: repo.path,
        err
      })
      return []
    }
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
