// @ts-nocheck -- mechanically split class members.
import { RuntimeFileCommandsWithCreateFileExplorerDirNoClobber } from './runtime-file-commands-create-file-explorer-dir-no-clobber'
import type { SearchOptions, SearchResult } from '../../shared/code-search-types'
import {
  requireRuntimeFileProvider,
  runtimeFileRouteForTarget
} from './runtime-file-command-target'
import { QUICK_OPEN_LISTING_MAX_RESULTS } from '../../shared/quick-open-listing-limits'
import { limitQuickOpenFilesBySerializedBytes } from '../../shared/quick-open-transport-budget'
import { listQuickOpenFiles } from '../ipc/filesystem-list-files'
import type { MarkdownDocument } from '../../shared/filesystem-entry-types'
import {
  listMarkdownDocuments,
  markdownDocumentsFromRelativePaths
} from '../ipc/markdown-documents'
import { stat } from 'node:fs/promises'
import { resolveAuthorizedPath } from '../ipc/filesystem-auth'

export class RuntimeFileCommandsWithSearchRuntimeFiles extends RuntimeFileCommandsWithCreateFileExplorerDirNoClobber {
  async searchRuntimeFiles(
    worktreeSelector: string,
    options: Omit<SearchOptions, 'rootPath'>
  ): Promise<SearchResult> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const provider = requireRuntimeFileProvider(target)
    const rootPath = target.worktree.path
    const searchOptions = { ...options, rootPath }
    if (provider) {
      return provider.search(searchOptions)
    }
    return this.searchLocalRuntimeFiles(rootPath, searchOptions)
  }

  async listRuntimeFiles(
    worktreeSelector: string,
    options: {
      excludePaths?: string[]
      maxContentBytes?: number
      maxResults?: number
      signal?: AbortSignal
    } = {}
  ): Promise<string[]> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const route = runtimeFileRouteForTarget(target)
    if (route.kind === 'ssh') {
      // Why: quick-open listings degrade to empty for an unreachable host rather than throwing.
      const provider = route.provider
      if (!provider) {
        return []
      }
      const maxResults =
        options.maxResults ??
        (options.maxContentBytes === undefined ? undefined : QUICK_OPEN_LISTING_MAX_RESULTS)
      const files = await provider.listFiles(target.worktree.path, {
        excludePaths: options.excludePaths,
        maxResults,
        signal: options.signal
      })
      return options.maxContentBytes === undefined
        ? files
        : limitQuickOpenFilesBySerializedBytes(files, options.maxContentBytes)
    }
    return listQuickOpenFiles(
      target.worktree.path,
      this.host.requireStore(),
      options.excludePaths,
      options.signal,
      options.maxResults,
      options.maxContentBytes
    )
  }

  async listRuntimeMarkdownDocuments(worktreeSelector: string): Promise<MarkdownDocument[]> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const provider = requireRuntimeFileProvider(target)
    if (provider) {
      const relativePaths = await provider.listFiles(target.worktree.path)
      return markdownDocumentsFromRelativePaths(target.worktree.path, relativePaths)
    }
    return listMarkdownDocuments(target.worktree.path)
  }

  async statRuntimeFile(
    worktreeSelector: string,
    relativePath: string
  ): Promise<{ size: number; isDirectory: boolean; mtime: number }> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    const provider = requireRuntimeFileProvider(target)
    if (provider) {
      const fileStat = await provider.stat(target.path)
      return {
        size: fileStat.size,
        isDirectory: fileStat.type === 'directory',
        mtime: fileStat.mtime
      }
    }
    const filePath = await resolveAuthorizedPath(target.path, this.host.requireStore())
    const stats = await stat(filePath)
    return { size: stats.size, isDirectory: stats.isDirectory(), mtime: stats.mtimeMs }
  }
}
