import {
  QUICK_OPEN_SEARCH_VERSION,
  isQuickOpenQueryTooLarge
} from '../../../../shared/quick-open-path-search'
import type { RuntimeFileListResult } from '../../../../shared/runtime-types'
import type { SearchOptions, SearchResult } from '../../../../shared/code-search-types'
import {
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../../../shared/abort-signal-reason'
import { listQuickOpenFiles } from '../../../ipc/filesystem/filesystem-list-files'
import { searchQuickOpenFilePaths as searchHostQuickOpenFilePaths } from '../../../ipc/filesystem/filesystem-search-file-paths'
import { isMobileBinaryPath, isSafeMobileRelativePath } from '../mobile-file-kind'
import {
  requireRuntimeFileProvider,
  runtimeFileRouteForTarget,
  type RuntimeLocalFileHost,
  type ResolvedRuntimeFileTarget
} from '../file-target'
import { basenameFromRelativePath } from '../file-paths'
import { RuntimeMobileFilePathSearchCache, rankRuntimeMobileFilePaths } from './mobile-path-search'

const MOBILE_FILE_LIST_LIMIT = 5000

const MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT = 20_000

const MOBILE_FILE_PATH_SEARCH_CACHE_ENTRIES = 8

const MOBILE_FILE_PATH_SEARCH_CACHE_TTL_MS = 30_000

type RuntimeFileSearchTarget = {
  worktree: Pick<ResolvedRuntimeFileTarget['worktree'], 'id' | 'path'>
  executionHostId: ResolvedRuntimeFileTarget['executionHostId']
}

export type RuntimeFileSearchHost = {
  requireStore: RuntimeLocalFileHost['requireStore']
  resolveRuntimeFileTarget(selector: string): Promise<RuntimeFileSearchTarget>
}

export class RuntimeFileSearch {
  private readonly mobileFilePathSearchCache = new RuntimeMobileFilePathSearchCache(
    MOBILE_FILE_PATH_SEARCH_CACHE_ENTRIES,
    MOBILE_FILE_PATH_SEARCH_CACHE_TTL_MS
  )

  constructor(private readonly host: RuntimeFileSearchHost) {}

  async listMobileFiles(
    worktreeSelector: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<RuntimeFileListResult> {
    const store = this.host.requireStore()
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree } = target
    const route = runtimeFileRouteForTarget(target)
    // Unsupported SSH hosts return empty, never this machine's files.
    const files =
      route.kind === 'ssh'
        ? []
        : await listQuickOpenFiles(
            worktree.path,
            store,
            undefined,
            options.signal,
            MOBILE_FILE_LIST_LIMIT + 1
          )
    const entries = files
      .filter((relativePath) => isSafeMobileRelativePath(relativePath))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MOBILE_FILE_LIST_LIMIT)
      .map((relativePath) => ({
        relativePath,
        basename: basenameFromRelativePath(relativePath),
        kind: isMobileBinaryPath(relativePath) ? ('binary' as const) : ('text' as const)
      }))

    return {
      worktree: worktree.id,
      rootPath: worktree.path,
      files: entries,
      totalCount: files.length,
      truncated: files.length > MOBILE_FILE_LIST_LIMIT
    }
  }

  async searchMobileFilePaths(
    worktreeSelector: string,
    query: string,
    limit: number
  ): Promise<RuntimeFileListResult> {
    const store = this.host.requireStore()
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree } = target
    const route = runtimeFileRouteForTarget(target)
    // Identical paths exist on multiple hosts; resolved-host identity must partition the cache.
    const cacheKey = `${target.executionHostId}:${worktree.id}:${worktree.path}`
    const inventory = await this.mobileFilePathSearchCache.get(cacheKey, async () => {
      const listed =
        route.kind === 'ssh'
          ? []
          : await listQuickOpenFiles(
              worktree.path,
              store,
              undefined,
              undefined,
              MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT + 1
            )
      const safePaths = listed
        .filter((relativePath) => isSafeMobileRelativePath(relativePath))
        .sort((a, b) => a.localeCompare(b))
      return {
        paths: safePaths.slice(0, MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT),
        totalCount: safePaths.length,
        truncated: safePaths.length > MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT
      }
    })
    const matches = rankRuntimeMobileFilePaths(inventory.paths, query, limit)
    return {
      worktree: worktree.id,
      rootPath: worktree.path,
      files: matches.paths.map((relativePath) => ({
        relativePath,
        basename: basenameFromRelativePath(relativePath),
        kind: isMobileBinaryPath(relativePath) ? ('binary' as const) : ('text' as const)
      })),
      totalCount: matches.totalCount,
      truncated: inventory.truncated || matches.totalCount > limit
    }
  }

  async searchQuickOpenFilePaths(
    worktreeSelector: string,
    query: string,
    limit: number,
    excludePaths?: string[],
    signal?: AbortSignal,
    options: {
      includeIgnored?: boolean
      followSymlinks?: boolean
      allowLegacyIncludeIgnored?: boolean
    } = {}
  ): Promise<RuntimeFileListResult> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree } = target
    const route = runtimeFileRouteForTarget(target)
    const quickOpenSearchVersion = route.kind === 'ssh' ? 0 : QUICK_OPEN_SEARCH_VERSION
    const result =
      !query.trim() || isQuickOpenQueryTooLarge(query) || route.kind === 'ssh'
        ? { paths: [], totalCount: 0, truncated: false }
        : await searchHostQuickOpenFilePaths(worktree.path, this.host.requireStore(), {
            ...options,
            query,
            limit,
            excludePaths,
            signal
          })
    return {
      worktree: worktree.id,
      rootPath: worktree.path,
      files: result.paths.map((relativePath) => ({
        relativePath,
        basename: basenameFromRelativePath(relativePath),
        kind: isMobileBinaryPath(relativePath) ? ('binary' as const) : ('text' as const)
      })),
      totalCount: result.totalCount,
      quickOpenSearchVersion,
      truncated: result.truncated
    }
  }

  async searchRuntimeFiles(
    worktreeSelector: string,
    options: Omit<SearchOptions, 'rootPath'>,
    requestOptions: { signal?: AbortSignal } = {}
  ): Promise<SearchResult> {
    throwIfSignalAborted(requestOptions.signal)
    const target = await waitForPromiseWithSignal(
      this.host.resolveRuntimeFileTarget(worktreeSelector),
      requestOptions.signal
    )
    throwIfSignalAborted(requestOptions.signal)
    const provider = requireRuntimeFileProvider(target, {
      requireStore: () => this.host.requireStore()
    })
    return provider.search({ ...options, rootPath: target.worktree.path }, requestOptions)
  }

  async listRuntimeFiles(
    worktreeSelector: string,
    options: {
      candidatePaths?: string[]
      includeIgnored?: boolean
      followSymlinks?: boolean
      excludePaths?: string[]
      maxContentBytes?: number
      maxResults?: number
      signal?: AbortSignal
    } = {}
  ): Promise<string[]> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const route = runtimeFileRouteForTarget(target)
    if (route.kind === 'ssh') {
      return []
    }
    return listQuickOpenFiles(
      target.worktree.path,
      this.host.requireStore(),
      options.excludePaths,
      options.signal,
      options.maxResults,
      options.maxContentBytes,
      undefined,
      options
    )
  }
}
