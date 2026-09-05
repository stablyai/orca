import type { BaseRefSearchResult, Repo } from '../../shared/repo-types'
import type { RuntimeRepoSearchRefs } from '../../shared/runtime-types'
import { isFolderRepo } from '../../shared/repo-kind'
import {
  clampRepoSearchRefsLimit,
  getRepoSearchRefsProbeLimit,
  isRepoSearchRefsRequestLimit
} from '../../shared/repo-search-limits'
import {
  buildSearchBaseRefsArgv,
  getBaseRefDefault,
  getRemoteCount,
  isForEachRefExcludeUnsupportedError,
  mergeBaseRefSearchResultGroups,
  normalizeRefSearchQuery,
  parseAndFilterSearchRefDetails,
  parseRemoteCount,
  resolveDefaultBaseRefViaExec,
  searchBaseRefDetails
} from '../git/repo'
import { getSshGitCapabilityCache } from '../git/git-capability-state'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'

type RuntimeRepositoryRefQueryDependencies = {
  resolveRepo: (selector: string) => Promise<Repo>
}

export class RuntimeRepositoryRefQueries {
  constructor(private readonly deps: RuntimeRepositoryRefQueryDependencies) {}

  async search(repoSelector: string, query: string, limit: number): Promise<RuntimeRepoSearchRefs> {
    if (!isRepoSearchRefsRequestLimit(limit)) {
      throw new Error('invalid_limit')
    }
    const effectiveLimit = clampRepoSearchRefsLimit(limit)
    const probeLimit = getRepoSearchRefsProbeLimit(effectiveLimit)
    const repo = await this.deps.resolveRepo(repoSelector)
    if (isFolderRepo(repo)) {
      return { refs: [], truncated: false }
    }
    const refDetails = repo.connectionId
      ? await this.searchRemote(repo, query, probeLimit)
      : await searchBaseRefDetails(repo.path, query, probeLimit)
    return {
      refs: refDetails.slice(0, effectiveLimit).map((entry) => entry.refName),
      refDetails: refDetails.slice(0, effectiveLimit),
      // An oversized request is intentionally reported as truncated even when
      // this repo has fewer refs: the execution cap prevented fulfilling the
      // requested page size.
      truncated: limit > effectiveLimit || refDetails.length > effectiveLimit
    }
  }

  async getDefault(
    repoSelector: string
  ): Promise<{ defaultBaseRef: string | null; remoteCount: number }> {
    const repo = await this.deps.resolveRepo(repoSelector)
    if (isFolderRepo(repo)) {
      return { defaultBaseRef: null, remoteCount: 0 }
    }
    if (repo.connectionId) {
      return this.getRemoteDefault(repo)
    }
    const [defaultBaseRef, remoteCount] = await Promise.all([
      getBaseRefDefault(repo.path),
      getRemoteCount(repo.path)
    ])
    return { defaultBaseRef, remoteCount }
  }

  private async getRemoteDefault(
    repo: Repo
  ): Promise<{ defaultBaseRef: string | null; remoteCount: number }> {
    const provider = repo.connectionId ? getSshGitProvider(repo.connectionId) : null
    if (!provider) {
      return { defaultBaseRef: null, remoteCount: 0 }
    }
    const [defaultBaseRef, remoteCount] = await Promise.all([
      resolveDefaultBaseRefViaExec(async (argv) => {
        try {
          return await provider.exec(argv, repo.path)
        } catch (error) {
          if (argv[0] === 'symbolic-ref') {
            console.warn('[runtime:repo.baseRefDefault] SSH symbolic-ref failed', {
              path: repo.path,
              err: error
            })
          }
          throw error
        }
      }),
      provider
        .exec(['remote'], repo.path)
        .then((result) => parseRemoteCount(result.stdout))
        .catch((error) => {
          console.warn('[runtime:repo.baseRefDefault] SSH git remote count failed', {
            path: repo.path,
            err: error
          })
          return 0
        })
    ])
    return { defaultBaseRef, remoteCount }
  }

  private async searchRemote(
    repo: Repo,
    query: string,
    limit: number
  ): Promise<BaseRefSearchResult[]> {
    const provider = repo.connectionId ? getSshGitProvider(repo.connectionId) : null
    if (!provider) {
      return []
    }
    const normalizedQuery = normalizeRefSearchQuery(query)
    try {
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
      if (normalizedQuery.split('/').filter((token) => token.length > 0).length > 1) {
        const results = await Promise.all([runSearch('segmented'), runSearch('branchRoot')])
        return mergeBaseRefSearchResultGroups(
          results.map((stdout) => parseAndFilterSearchRefDetails(stdout, limit, remotes)),
          limit
        )
      }
      return parseAndFilterSearchRefDetails(await runSearch(), limit, remotes)
    } catch (error) {
      console.warn('[runtime:repo.searchRefs] SSH for-each-ref failed', {
        path: repo.path,
        err: error
      })
      return []
    }
  }
}
