// @ts-nocheck -- mechanically split class members.
import { RuntimeFileCommandsWithSearchRuntimeFiles } from './runtime-file-commands-search-runtime-files'
import type { SearchOptions, SearchResult } from '../../shared/code-search-types'
import { resolveAuthorizedPath } from '../ipc/filesystem-auth'
import { getLocalGitOptionsForRegisteredWorktree } from '../ipc/local-worktree-runtime-options'
import {
  DEFAULT_SEARCH_MAX_RESULTS,
  SEARCH_TIMEOUT_MS,
  buildRgArgs,
  createAccumulator,
  finalize,
  ingestRgJsonLine
} from '../../shared/text-search'
import { parseWslPath, toWindowsWslPath } from '../wsl'
import { checkRgAvailable } from '../ipc/rg-availability'
import { searchWithGitGrep } from '../ipc/filesystem-search-git'
import {
  absorbPendingRipgrepSpawnError,
  isRipgrepUnavailableExit,
  killSpawnedRipgrepProcess
} from '../../shared/ripgrep-process-availability'
import type { ChildProcessHandle } from '../../shared/child-process/process-spec'
import { wslAwareSpawn } from '../git/runner'
import type { RuntimeFileExplorerPath } from './runtime-file-command-target'
import type { IFilesystemProvider } from '../providers/types'
import { joinWorktreeRelativePath, normalizeRuntimeRelativePath } from './runtime-relative-paths'

export class RuntimeFileCommandsWithSearchLocalRuntimeFiles extends RuntimeFileCommandsWithSearchRuntimeFiles {
  protected async searchLocalRuntimeFiles(
    rootPath: string,
    options: SearchOptions
  ): Promise<SearchResult> {
    const store = this.host.requireStore()
    const authorizedRootPath = await resolveAuthorizedPath(rootPath, store)
    const localGitOptions = getLocalGitOptionsForRegisteredWorktree(
      store,
      rootPath,
      authorizedRootPath
    )
    const maxResults = Math.max(
      1,
      Math.min(options.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS, DEFAULT_SEARCH_MAX_RESULTS)
    )
    const wslInfo = parseWslPath(authorizedRootPath)
    if (
      (wslInfo || localGitOptions.wslDistro) &&
      !(await checkRgAvailable(authorizedRootPath, localGitOptions.wslDistro))
    ) {
      return searchWithGitGrep(authorizedRootPath, options, maxResults, localGitOptions)
    }

    return new Promise<SearchResult>((resolvePromise) => {
      const searchKey = `${this.host.getRuntimeId()}:${authorizedRootPath}`
      const rgArgs = buildRgArgs(options.query, authorizedRootPath, options)
      const previousChild = this.activeRuntimeTextSearches.get(searchKey)
      if (previousChild) {
        killSpawnedRipgrepProcess(previousChild)
      }

      const acc = createAccumulator()
      let stdoutBuffer = ''
      let resolved = false
      let processErrorObserved = false
      let unavailableExitObserved = false
      let child: ChildProcessHandle | null = null
      const transformAbsPath = wslInfo
        ? (p: string): string => toWindowsWslPath(p, wslInfo.distro)
        : undefined

      const finish = (result: SearchResult | PromiseLike<SearchResult>): void => {
        if (resolved) {
          return
        }
        resolved = true
        if (this.activeRuntimeTextSearches.get(searchKey) === child) {
          this.activeRuntimeTextSearches.delete(searchKey)
        }
        cleanupListeners()
        resolvePromise(result)
      }
      const resolveOnce = (): void => finish(finalize(acc))
      const resolveWithoutRipgrep = (): void =>
        finish(searchWithGitGrep(authorizedRootPath, options, maxResults, localGitOptions))

      let killTimeout: ReturnType<typeof setTimeout> | null = null
      const cleanupListeners = (): void => {
        if (killTimeout) {
          clearTimeout(killTimeout)
          killTimeout = null
        }
        child?.stdout?.off('data', onStdoutData)
        child?.stderr?.off('data', onStderrData)
        child?.off('error', onError)
        child?.off('close', onClose)
        if (child) {
          absorbPendingRipgrepSpawnError(child, {
            errorObserved: processErrorObserved,
            unavailableExitObserved
          })
        }
      }

      const processLine = (line: string): void => {
        const verdict = ingestRgJsonLine(
          line,
          authorizedRootPath,
          acc,
          maxResults,
          transformAbsPath
        )
        if (verdict === 'stop' && child) {
          killSpawnedRipgrepProcess(child)
        }
      }

      const nextChild = wslAwareSpawn('rg', rgArgs, {
        cwd: authorizedRootPath,
        ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
        stdio: ['ignore', 'pipe', 'pipe']
      })
      child = nextChild
      this.activeRuntimeTextSearches.set(searchKey, nextChild)

      nextChild.stdout!.setEncoding('utf-8')
      const onStdoutData = (chunk: string): void => {
        stdoutBuffer += chunk
        const lines = stdoutBuffer.split('\n')
        stdoutBuffer = lines.pop() ?? ''
        for (const line of lines) {
          processLine(line)
        }
      }
      const onStderrData = (): void => {
        // Drain stderr so rg cannot block on a full pipe.
      }
      const onError = (): void => {
        processErrorObserved = true
        if (child && isRipgrepUnavailableExit(child, null, null)) {
          resolveWithoutRipgrep()
          return
        }
        resolveOnce()
      }
      const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (
          child &&
          isRipgrepUnavailableExit(child, code, signal, {
            classifyNativeLauncherExit: !(wslInfo || localGitOptions.wslDistro)
          })
        ) {
          unavailableExitObserved = true
          resolveWithoutRipgrep()
          return
        }
        if (stdoutBuffer) {
          processLine(stdoutBuffer)
        }
        resolveOnce()
      }

      nextChild.stdout!.on('data', onStdoutData)
      nextChild.stderr!.on('data', onStderrData)
      nextChild.once('error', onError)
      nextChild.once('close', onClose)

      killTimeout = setTimeout(() => {
        acc.truncated = true
        if (child) {
          killSpawnedRipgrepProcess(child)
        }
        resolveOnce()
      }, SEARCH_TIMEOUT_MS)
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
        normalizeRuntimeRelativePath(relativePath)
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
