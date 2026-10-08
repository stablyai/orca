// @ts-nocheck -- mechanically split class members.
import { RuntimeFileCommandsWithCreateFileExplorerDirNoClobber } from './runtime-file-commands-create-file-explorer-dir-no-clobber'
import { listFilesystemMarkdownDocuments } from '../providers/filesystem-markdown-listing'
import type { SearchOptions, SearchResult } from '../../shared/code-search-types'
import {
  requireRuntimeFileProvider,
  runtimeFileRouteForTarget
} from './runtime-file-command-target'
import { QUICK_OPEN_LISTING_MAX_RESULTS } from '../../shared/quick-open-listing-limits'
import { limitQuickOpenFilesBySerializedBytes } from '../../shared/quick-open-transport-budget'
import { listQuickOpenFiles } from '../ipc/filesystem-list-files'
import type { MarkdownDocument } from '../../shared/filesystem-entry-types'
import { listMarkdownDocuments } from '../ipc/markdown-documents'
import { getLocalGitOptionsForRegisteredWorktree } from '../ipc/local-worktree-runtime-options'
import {
  validatePathExistenceBatch,
  type PathExistenceResult
} from '../../shared/path-existence-batch'
import { readRuntimeFilePathExistence } from './runtime-file-path-existence'
import { stat } from 'node:fs/promises'
import { resolveAuthorizedPath } from '../ipc/filesystem-auth'
import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../shared/abort-signal-reason'

export class RuntimeFileCommandsWithSearchRuntimeFiles extends RuntimeFileCommandsWithCreateFileExplorerDirNoClobber {
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
    const provider = requireRuntimeFileProvider(target)
    const rootPath = target.worktree.path
    const searchOptions = { ...options, rootPath }
    if (provider) {
      return provider.search(searchOptions, requestOptions)
    }
    return this.searchLocalRuntimeFiles(rootPath, searchOptions, requestOptions.signal)
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
      // Why: quick-open listings degrade to empty for an unreachable host rather than throwing.
      const provider = route.provider
      if (!provider) {
        return []
      }
      const maxResults =
        options.maxResults ??
        (options.maxContentBytes === undefined ? undefined : QUICK_OPEN_LISTING_MAX_RESULTS)
      if (
        (options.candidatePaths !== undefined ||
          options.includeIgnored === false ||
          options.followSymlinks) &&
        !(await provider.supportsQuickOpenSearch?.({
          signal: options.signal,
          minimumVersion: options.candidatePaths !== undefined ? 3 : 2
        }))
      ) {
        throw new Error(
          options.candidatePaths !== undefined
            ? 'Update the remote host to validate Quick Open recent files.'
            : 'Update the remote host to use Quick Open listing options.'
        )
      }
      const files = await provider.listFiles(target.worktree.path, {
        excludePaths: options.excludePaths,
        ...(options.candidatePaths === undefined ? {} : { candidatePaths: options.candidatePaths }),
        includeIgnored: options.includeIgnored,
        followSymlinks: options.followSymlinks,
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
      options.maxContentBytes,
      undefined,
      options
    )
  }

  async listRuntimeMarkdownDocuments(worktreeSelector: string): Promise<MarkdownDocument[]> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const provider = requireRuntimeFileProvider(target)
    if (provider) {
      return listFilesystemMarkdownDocuments(provider, target.worktree.path)
    }
    return listMarkdownDocuments(
      target.worktree.path,
      getLocalGitOptionsForRegisteredWorktree(
        this.host.requireStore(),
        target.worktree.path,
        target.worktree.path
      )
    )
  }

  async pathsExistRuntimeFiles(
    worktreeSelector: string,
    relativePaths: string[]
  ): Promise<PathExistenceResult[]> {
    validatePathExistenceBatch(relativePaths)
    const targets = await this.resolveFileExplorerPaths(worktreeSelector, relativePaths)
    return readRuntimeFilePathExistence(targets, () => this.host.requireStore())
  }

  async statRuntimeFile(
    worktreeSelector: string,
    relativePath: string
  ): Promise<{ size: number; isDirectory: boolean; mtime: number; ctime?: number }> {
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
    return {
      size: stats.size,
      isDirectory: stats.isDirectory(),
      mtime: stats.mtimeMs,
      ctime: stats.ctimeMs
    }
  }
}
