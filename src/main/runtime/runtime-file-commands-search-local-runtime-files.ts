// @ts-nocheck -- mechanically split class members.
import { RuntimeFileCommandsWithSearchRuntimeFiles } from './runtime-file-commands-search-runtime-files'
import type { RuntimeFileExplorerPath } from './runtime-file-command-target'
import type { IFilesystemProvider } from '../providers/types'
import { joinWorktreeRelativePath, normalizeRuntimeRelativePath } from './runtime-relative-paths'

export class RuntimeFileCommandsWithSearchLocalRuntimeFiles extends RuntimeFileCommandsWithSearchRuntimeFiles {
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
