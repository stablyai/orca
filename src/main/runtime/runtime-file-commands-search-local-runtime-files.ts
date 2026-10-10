// @ts-nocheck -- mechanically split class members.
import { randomUUID } from 'node:crypto'
import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { RuntimeFileCommandsWithSearchRuntimeFiles } from './runtime-file-commands-search-runtime-files'
import type { SearchOptions, SearchResult } from '../../shared/code-search-types'
import { resolveAuthorizedPath } from '../ipc/filesystem-auth'
import { getLocalGitOptionsForRegisteredWorktree } from '../ipc/local-worktree-runtime-options'
import { parseWslPath } from '../wsl'
import { runBundledRipgrepTextSearch } from '../ripgrep/bundled-ripgrep-text-search'
import type { RuntimeFileExplorerPath } from './runtime-file-command-target'
import type { IFilesystemProvider } from '../providers/types'
import { joinWorktreeRelativePath, normalizeRuntimeRelativePath } from './runtime-relative-paths'

export class RuntimeFileCommandsWithSearchLocalRuntimeFiles extends RuntimeFileCommandsWithSearchRuntimeFiles {
  protected async searchLocalRuntimeFiles(
    rootPath: string,
    options: SearchOptions,
    signal?: AbortSignal
  ): Promise<SearchResult> {
    throwIfSignalAborted(signal)
    const store = this.host.requireStore()
    const authorizedRootPath = await waitForPromiseWithSignal(
      resolveAuthorizedPath(rootPath, store),
      signal
    )
    throwIfSignalAborted(signal)
    const localGitOptions = getLocalGitOptionsForRegisteredWorktree(
      store,
      rootPath,
      authorizedRootPath
    )
    const wslDistroForOutput = parseWslPath(authorizedRootPath)?.distro ?? localGitOptions.wslDistro

    const searchKey = randomUUID()
    return runBundledRipgrepTextSearch({
      options,
      rootPath: authorizedRootPath,
      resultRootPath: authorizedRootPath,
      wslDistro: localGitOptions.wslDistro,
      wslDistroForOutput,
      signal,
      onSpawn: (child) => {
        this.activeRuntimeTextSearches.set(searchKey, child)
        return () => {
          if (this.activeRuntimeTextSearches.get(searchKey) === child) {
            this.activeRuntimeTextSearches.delete(searchKey)
          }
        }
      }
    })
  }

  protected async resolveFileExplorerPath(
    worktreeSelector: string,
    relativePath: string
  ): Promise<RuntimeFileExplorerPath> {
    const [target] = await this.resolveFileExplorerPaths(worktreeSelector, [relativePath])
    return target
  }

  protected async resolveFileExplorerPaths(
    worktreeSelector: string,
    relativePaths: readonly string[]
  ): Promise<RuntimeFileExplorerPath[]> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    return relativePaths.map((relativePath) => ({
      worktree: target.worktree,
      path: joinWorktreeRelativePath(
        target.worktree.path,
        normalizeRuntimeRelativePath(relativePath, target.worktree.path)
      ),
      executionHostId: target.executionHostId
    }))
  }

  // `null` provider is the caller's "this host is unreachable" answer, not "list it here".
  protected async listRemoteMobileFiles(
    rootPath: string,
    provider: IFilesystemProvider | null,
    maxResults?: number,
    signal?: AbortSignal
  ): Promise<string[]> {
    if (!provider) {
      return []
    }
    return provider.listFiles(rootPath, { maxResults, signal })
  }
}
