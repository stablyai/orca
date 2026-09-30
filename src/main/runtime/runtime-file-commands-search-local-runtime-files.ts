// @ts-nocheck -- mechanically split class members.
import { SearchSubprocessLineAccumulator } from '../../shared/search-subprocess-lines'
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
import { bundledRipgrepUnavailableError } from '../ripgrep/bundled-ripgrep-path'
import { spawnBundledRipgrep } from '../ripgrep/bundled-ripgrep-spawn'
import {
  absorbPendingRipgrepSpawnError,
  classifySynchronousRipgrepSpawnFailure,
  isRipgrepMissingCwdExit,
  isRipgrepSpawnCwdUsable,
  isRipgrepUnavailableExit,
  isTransientRipgrepSpawnError,
  killSpawnedRipgrepProcess,
  ripgrepMissingCwdError
} from '../../shared/ripgrep-process-availability'
import type { ChildProcessHandle } from '../../shared/child-process/process-spec'
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
    const wslDistroForOutput = parseWslPath(authorizedRootPath)?.distro ?? localGitOptions.wslDistro

    return new Promise<SearchResult>((resolvePromise, rejectPromise) => {
      const searchKey = `${this.host.getRuntimeId()}:${authorizedRootPath}`
      const rgArgs = buildRgArgs(options.query, authorizedRootPath, options)
      const previousChild = this.activeRuntimeTextSearches.get(searchKey)
      if (previousChild) {
        killSpawnedRipgrepProcess(previousChild)
      }

      const acc = createAccumulator()
      const lines = new SearchSubprocessLineAccumulator(Number.MAX_SAFE_INTEGER)
      let resolved = false
      let processErrorObserved = false
      let unavailableExitObserved = false
      let child: ChildProcessHandle | null = null
      const transformAbsPath = wslDistroForOutput
        ? (p: string): string => (p.startsWith('/') ? toWindowsWslPath(p, wslDistroForOutput) : p)
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
      const rejectUnavailable = (): void => finish(Promise.reject(bundledRipgrepUnavailableError()))

      let killTimeout: ReturnType<typeof setTimeout> | null = null
      const cleanupListeners = (): void => {
        lines.clear()
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

      // A synchronous spawn failure has no child to clean up.
      let nextChild: ReturnType<typeof spawnBundledRipgrep>
      try {
        nextChild = spawnBundledRipgrep(rgArgs, {
          cwd: authorizedRootPath,
          wslDistro: localGitOptions.wslDistro,
          wslDistroForOutput,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (error) {
        void classifySynchronousRipgrepSpawnFailure(error, authorizedRootPath).then(
          rejectPromise,
          rejectPromise
        )
        return
      }
      child = nextChild
      this.activeRuntimeTextSearches.set(searchKey, nextChild)

      nextChild.stdout?.setEncoding('utf-8')
      const onStdoutData = (chunk: string): void => {
        lines.push(chunk, processLine)
      }
      const onStderrData = (): void => {
        // Drain stderr so rg cannot block on a full pipe.
      }
      const onError = (error: NodeJS.ErrnoException): void => {
        processErrorObserved = true
        // Why: fd/process pressure is not a broken install; say so instead of blaming the bundled binary.
        if (isTransientRipgrepSpawnError(error)) {
          finish(Promise.reject(new Error(`rg could not start (${error.code}); try again`)))
          return
        }
        if (child && isRipgrepUnavailableExit(child, null, null)) {
          // Why the cwd check first: spawn reports a missing cwd as ENOENT too, and blaming the
          // binary for it tells the user to reinstall Orca over a workspace that simply moved.
          // Why detach close first: a failed spawn emits error THEN close(code < 0), and close
          // settles synchronously, so this probe would otherwise race it on a sub-millisecond
          // margin -- two measurements disagreed on which wins. Detaching makes it deterministic.
          child.off('close', onClose)
          // Why catch: a failed probe must not strand the search; fall back to the prior verdict.
          void isRipgrepSpawnCwdUsable(authorizedRootPath)
            .catch(() => true)
            .then((usable) => {
              // Why re-check: finish() drops its argument once settled, so a rejected promise
              // built after the close handler already won would go unhandled.
              if (resolved) {
                return
              }
              finish(
                Promise.reject(
                  usable
                    ? bundledRipgrepUnavailableError()
                    : ripgrepMissingCwdError(authorizedRootPath)
                )
              )
            })
          return
        }
        resolveOnce()
      }
      const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        // Why first: this code is above rg's own 0/1/2, so the unavailable check would otherwise
        // read an unreachable workspace as a broken install and tell the user to reinstall Orca.
        if (isRipgrepMissingCwdExit(code)) {
          finish(Promise.reject(ripgrepMissingCwdError(authorizedRootPath)))
          return
        }
        if (
          child &&
          isRipgrepUnavailableExit(child, code, signal, {
            classifyNativeLauncherExit: true
          })
        ) {
          unavailableExitObserved = true
          rejectUnavailable()
          return
        }
        const tail = lines.finish()
        if (tail !== null) {
          processLine(tail)
        }
        resolveOnce()
      }

      nextChild.stdout?.on('data', onStdoutData)
      nextChild.stderr?.on('data', onStderrData)
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
