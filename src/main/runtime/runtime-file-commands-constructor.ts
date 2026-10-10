// @ts-nocheck -- mechanically split class members.
import {
  QUICK_OPEN_SEARCH_VERSION,
  isQuickOpenQueryTooLarge
} from '../../shared/quick-open-path-search'
import {
  RuntimeFileCommandsWithActiveRuntimeTextSearches,
  RuntimeFileCommandsWithActiveRuntimeTextSearches as RuntimeFileCommands
} from './runtime-file-commands-active-runtime-text-searches'
import type { RuntimeFileCommandHost } from './runtime-file-command-host'
import {
  isMobileBinaryPath,
  isMobileMarkdownPath,
  isSafeMobileRelativePath
} from './runtime-file-command-host'
import { basenameFromRelativePath } from './runtime-file-paths'
import type { RuntimeFileListResult, RuntimeFileOpenResult } from '../../shared/runtime-types'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import { listQuickOpenFiles } from '../ipc/filesystem-list-files'
import {
  MOBILE_FILE_LIST_LIMIT,
  MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT,
  isMobilePreviewableImagePath
} from './runtime-file-commands-mobile-file-list-limit'
import { rankRuntimeMobileFilePaths } from './runtime-mobile-file-path-search'
import { searchQuickOpenFilePaths as searchHostQuickOpenFilePaths } from '../ipc/filesystem-search-file-paths'
import { joinWorktreeRelativePath } from './runtime-relative-paths'
import { isENOENT } from '../ipc/filesystem-path-containment'
import {
  requireRuntimeFileProvider,
  runtimeFileRouteForTarget
} from './runtime-file-command-target'
import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { FileStat } from '../providers/types'

export class RuntimeFileCommandsWithConstructor extends RuntimeFileCommandsWithActiveRuntimeTextSearches {
  constructor(private readonly host: RuntimeFileCommandHost) {
    super()
  }

  async listMobileFiles(
    worktreeSelector: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<RuntimeFileListResult> {
    const store = this.host.requireStore()
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree } = target
    const route = runtimeFileRouteForTarget(target)
    const files =
      route.kind === 'ssh'
        ? await this.listRemoteMobileFiles(
            worktree.path,
            route.provider,
            MOBILE_FILE_LIST_LIMIT + 1,
            options.signal
          )
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
    // Why: identical paths exist on local and on several SSH hosts; the cache key must name the
    // resolved host, which `connectionId` could not tell apart from "unresolved".
    const cacheKey = `${target.executionHostId}:${worktree.id}:${worktree.path}`
    const inventory = await this.mobileFilePathSearchCache.get(cacheKey, async () => {
      const listed =
        route.kind === 'ssh'
          ? await this.listRemoteMobileFiles(
              worktree.path,
              route.provider,
              MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT + 1
            )
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
    const quickOpenSearchVersion =
      route.kind !== 'ssh'
        ? QUICK_OPEN_SEARCH_VERSION
        : (await route.provider?.supportsQuickOpenSearch?.({ signal, minimumVersion: 3 }))
          ? 3
          : (await route.provider?.supportsQuickOpenSearch?.({ signal, minimumVersion: 2 }))
            ? 2
            : (await route.provider?.supportsQuickOpenSearch?.({ signal, minimumVersion: 1 }))
              ? 1
              : 0
    const result =
      !query.trim() || isQuickOpenQueryTooLarge(query)
        ? { paths: [], totalCount: 0, truncated: false }
        : route.kind === 'ssh'
          ? await this.searchRemoteQuickOpenFilePaths(
              worktree.path,
              route.provider,
              query,
              limit,
              excludePaths,
              signal,
              options
            )
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

  async openMobileFile(
    worktreeSelector: string,
    relativePath: string,
    navigation?: RuntimeNavigationTarget
  ): Promise<RuntimeFileOpenResult> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree } = target
    if (!isSafeMobileRelativePath(relativePath)) {
      throw new Error('invalid_relative_path')
    }
    const kind = isMobilePreviewableImagePath(relativePath)
      ? 'image'
      : isMobileBinaryPath(relativePath)
        ? 'binary'
        : isMobileMarkdownPath(relativePath)
          ? 'markdown'
          : 'text'
    // Why: `kind` only describes the file; the desktop editor opens binaries (e.g. PDFs) like the File Explorer.
    const filePath = joinWorktreeRelativePath(worktree.path, relativePath)
    // Why: CLI/agents treat opened:true as success; stat first so missing paths and directories fail the RPC instead of opening a ghost tab.
    await this.assertOpenTargetIsFile(filePath, target)
    this.host.openFile(
      worktree.id,
      filePath,
      relativePath,
      runtimeOwnerForTarget(target),
      navigation
    )
    return { worktree: worktree.id, relativePath, kind, opened: true }
  }

  protected async assertOpenTargetIsFile(
    filePath: string,
    target: { executionHostId: ExecutionHostId }
  ): Promise<void> {
    const route = runtimeFileRouteForTarget(target)
    let stats: FileStat
    try {
      stats = await requireRuntimeFileProvider(target, this.host, route).stat(filePath)
    } catch (error) {
      if (
        isENOENT(error) ||
        (route.kind === 'ssh' && RuntimeFileCommands.isRemoteNotFoundErrorMessage(error))
      ) {
        throw new Error(`ENOENT: no such file or directory, open '${filePath}'`)
      }
      throw error
    }
    if (stats.type === 'directory') {
      throw new Error(`EISDIR: illegal operation on a directory, open '${filePath}'`)
    }
  }

  async openMobileDiff(
    worktreeSelector: string,
    relativePath: string,
    staged: boolean,
    navigation?: RuntimeNavigationTarget
  ): Promise<RuntimeFileOpenResult> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree } = target
    if (!isSafeMobileRelativePath(relativePath)) {
      throw new Error('invalid_relative_path')
    }
    const kind = isMobileBinaryPath(relativePath)
      ? 'binary'
      : isMobileMarkdownPath(relativePath)
        ? 'markdown'
        : 'text'
    const filePath = joinWorktreeRelativePath(worktree.path, relativePath)
    this.host.openDiff(
      worktree.id,
      filePath,
      relativePath,
      staged,
      runtimeOwnerForTarget(target),
      navigation
    )
    return { worktree: worktree.id, relativePath, kind, opened: true }
  }
}

// Why: name the resolved owner; undefined would let the renderer fall back to the focused server.
function runtimeOwnerForTarget(target: { executionHostId: ExecutionHostId }): string | null {
  const host = parseExecutionHostId(target.executionHostId)
  return host?.kind === 'runtime' ? host.environmentId : null
}
