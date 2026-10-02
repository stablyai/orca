import { SearchSubprocessLineAccumulator } from '../../../shared/search-subprocess-lines'
import { ipcMain } from 'electron'
import type { ChildProcess } from 'node:child_process'
import type { SearchOptions, SearchResult } from '../../../shared/code-search-types'
import {
  buildRgArgs,
  createAccumulator,
  DEFAULT_SEARCH_MAX_RESULTS,
  finalize,
  ingestRgJsonLine,
  SEARCH_TIMEOUT_MS
} from '../../../shared/text-search'
import {
  absorbPendingRipgrepSpawnError,
  classifySynchronousRipgrepSpawnFailure,
  isRipgrepMissingCwdExit,
  isRipgrepSpawnCwdUsable,
  isRipgrepUnavailableExit,
  isTransientRipgrepSpawnError,
  killSpawnedRipgrepProcess,
  ripgrepMissingCwdError
} from '../../../shared/ripgrep-process-availability'
import { toWindowsWslPath, parseWslPath } from '../../wsl'
import {
  getSshFilesystemProvider,
  requireSshFilesystemProvider
} from '../../providers/ssh-filesystem-dispatch'
import { resolveAuthorizedPath } from '../filesystem-auth'
import { listQuickOpenFiles } from '../filesystem-list-files'
import {
  isFileNameFilterQueryTooLarge,
  pathMatchesFileNameFilterTokens,
  splitFileNameFilterTokens
} from '../../../shared/file-name-filter-tokens'
import { bundledRipgrepUnavailableError } from '../../ripgrep/bundled-ripgrep-path'
import { spawnBundledRipgrep } from '../../ripgrep/bundled-ripgrep-spawn'
import { getLocalGitOptionsForRegisteredWorktree } from '../local-worktree-runtime-options'
import { QuickOpenPathRanker } from '../../../shared/quick-open-path-search'
import type { FilesystemHandlerContext } from './filesystem-handler-context'

// 32 visible matches plus one truncation sentinel stays below the legacy frame ceiling.
const QUICK_OPEN_SSH_LEGACY_RESULT_LIMIT = 33

export function registerFilesystemSearchHandlers(context: FilesystemHandlerContext): void {
  const { store, activeTextSearches } = context

  ipcMain.handle(
    'fs:search',
    async (event, args: SearchOptions & { connectionId?: string }): Promise<SearchResult> => {
      if (args.connectionId) {
        const provider = requireSshFilesystemProvider(args.connectionId)
        return provider.search(args)
      }
      const rootPath = await resolveAuthorizedPath(args.rootPath, store)
      const localGitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.rootPath,
        rootPath
      )
      const maxResults = Math.max(
        1,
        Math.min(args.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS, DEFAULT_SEARCH_MAX_RESULTS)
      )
      const searchKey = `${event.sender.id}:${rootPath}`
      const wslDistroForOutput = parseWslPath(rootPath)?.distro ?? localGitOptions.wslDistro

      return new Promise<SearchResult>((resolvePromise, rejectPromise) => {
        const rgArgs = buildRgArgs(args.query, rootPath, args)
        // Why: kill the prior rg so it stops parsing thousands of matches on the main thread (the large-repo freeze) after the UI moved on.
        const previousChild = activeTextSearches.get(searchKey)
        if (previousChild) {
          killSpawnedRipgrepProcess(previousChild)
        }

        const acc = createAccumulator()
        const lines = new SearchSubprocessLineAccumulator(Number.MAX_SAFE_INTEGER)
        let resolved = false
        let processErrorObserved = false
        let unavailableExitObserved = false
        let child: ChildProcess | null = null
        let killTimeout: ReturnType<typeof setTimeout>

        const transformAbsPath = wslDistroForOutput
          ? (path: string): string =>
              path.startsWith('/') ? toWindowsWslPath(path, wslDistroForOutput) : path
          : undefined

        const finish = (result: SearchResult | PromiseLike<SearchResult>): void => {
          if (resolved) {
            return
          }
          resolved = true
          if (activeTextSearches.get(searchKey) === child) {
            activeTextSearches.delete(searchKey)
          }
          lines.clear()
          clearTimeout(killTimeout)
          // Why: child.kill() is advisory; detach our closures so repeated searches don't retain old scans if rg ignores it.
          child?.stdout?.off('data', handleStdoutData)
          child?.stderr?.off('data', handleStderrData)
          child?.off('error', handleError)
          child?.off('close', handleClose)
          if (child) {
            absorbPendingRipgrepSpawnError(child, {
              errorObserved: processErrorObserved,
              unavailableExitObserved
            })
          }
          resolvePromise(result)
        }
        const resolveOnce = (): void => finish(finalize(acc))
        const rejectUnavailable = (): void =>
          finish(Promise.reject(bundledRipgrepUnavailableError()))
        const processLine = (line: string): void => {
          const verdict = ingestRgJsonLine(line, rootPath, acc, maxResults, transformAbsPath)
          if (verdict === 'stop' && child) {
            killSpawnedRipgrepProcess(child)
          }
        }

        // A synchronous spawn failure has no child to clean up.
        let nextChild: ReturnType<typeof spawnBundledRipgrep>
        try {
          nextChild = spawnBundledRipgrep(rgArgs, {
            cwd: rootPath,
            wslDistro: localGitOptions.wslDistro,
            wslDistroForOutput,
            stdio: ['ignore', 'pipe', 'pipe']
          })
        } catch (error) {
          void classifySynchronousRipgrepSpawnFailure(error, rootPath).then(
            rejectPromise,
            rejectPromise
          )
          return
        }
        child = nextChild
        activeTextSearches.set(searchKey, nextChild)

        const handleStdoutData = (chunk: string): void => {
          lines.push(chunk, processLine)
        }
        const handleStderrData = (): void => {
          // Drain stderr so rg cannot block on a full pipe.
        }
        const handleError = (error: NodeJS.ErrnoException): void => {
          processErrorObserved = true
          // Why: fd/process pressure is not a broken install; say so instead of blaming the bundled binary.
          if (isTransientRipgrepSpawnError(error)) {
            finish(Promise.reject(new Error(`rg could not start (${error.code}); try again`)))
            return
          }
          if (child && isRipgrepUnavailableExit(child, null, null)) {
            // Why the cwd check first: spawn reports a missing cwd as ENOENT too, and blaming the
            // binary for it tells the user to reinstall Orca over a workspace that simply moved.
            // Why detach close first: a failed spawn emits error THEN close(code < 0), and
            // close settles synchronously, so this probe would otherwise race it on a sub-ms
            // margin -- two measurements disagreed on which wins. Detaching makes it deterministic.
            child.off('close', handleClose)
            // Why catch: a failed probe must not strand the search; fall back to the prior verdict.
            void isRipgrepSpawnCwdUsable(rootPath)
              .catch(() => true)
              .then((usable) => {
                // Why re-check: finish() drops its argument once settled, so a rejected promise
                // built after the close handler already won would go unhandled.
                if (resolved) {
                  return
                }
                finish(
                  Promise.reject(
                    usable ? bundledRipgrepUnavailableError() : ripgrepMissingCwdError(rootPath)
                  )
                )
              })
            return
          }
          resolveOnce()
        }
        const handleClose = (code: number | null, signal: NodeJS.Signals | null): void => {
          // Why first: this code is above rg's own 0/1/2, so the unavailable check would otherwise
          // read an unreachable workspace as a broken install and tell the user to reinstall Orca.
          if (isRipgrepMissingCwdExit(code)) {
            finish(Promise.reject(ripgrepMissingCwdError(rootPath)))
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

        nextChild.stdout?.setEncoding('utf-8')
        nextChild.stdout?.on('data', handleStdoutData)
        nextChild.stderr?.on('data', handleStderrData)
        nextChild.once('error', handleError)
        nextChild.once('close', handleClose)

        // Why: timeout kills the child mid-scan; mark truncated so the UI shows incomplete results.
        killTimeout = setTimeout(() => {
          acc.truncated = true
          if (child) {
            killSpawnedRipgrepProcess(child)
          }
          resolveOnce()
        }, SEARCH_TIMEOUT_MS)
      })
    }
  )

  const { listFilesCancellations } = context
  ipcMain.handle(
    'fs:listFiles',
    async (
      event,
      args: {
        rootPath: string
        connectionId?: string
        excludePaths?: string[]
        requestToken?: string
        maxResults?: number
        searchQuery?: string
        /** Local only: keep paths containing every whitespace-separated word, like the Explorer filter. */
        nameFilter?: string
      }
    ): Promise<string[]> => {
      const controller = listFilesCancellations.begin(event, args.requestToken)
      try {
        if (args.connectionId) {
          const provider = getSshFilesystemProvider(args.connectionId)
          // Why: no provider (cold start / disconnected) → return [] so quick-open shows "No matching files" instead of an error.
          if (!provider) {
            return []
          }
          // Why: forward excludePaths or nested linked worktrees get double-scanned over SSH, causing timeout-induced partial results.
          if (
            args.searchQuery !== undefined &&
            provider.supportsQuickOpenSearch &&
            !(await provider.supportsQuickOpenSearch({ signal: controller?.signal }))
          ) {
            const legacyFiles = await provider.listFiles(args.rootPath, {
              excludePaths: args.excludePaths,
              maxResults: QUICK_OPEN_SSH_LEGACY_RESULT_LIMIT,
              signal: controller?.signal
            })
            const ranker = new QuickOpenPathRanker(
              args.searchQuery,
              args.maxResults ?? QUICK_OPEN_SSH_LEGACY_RESULT_LIMIT
            )
            for (const file of legacyFiles) {
              ranker.consider(file)
            }
            return ranker.result().paths
          }
          return await provider.listFiles(args.rootPath, {
            excludePaths: args.excludePaths,
            ...(args.maxResults === undefined ? {} : { maxResults: args.maxResults }),
            ...(args.searchQuery === undefined ? {} : { searchQuery: args.searchQuery }),
            signal: controller?.signal
          })
        }
        if (args.nameFilter !== undefined && isFileNameFilterQueryTooLarge(args.nameFilter)) {
          return []
        }
        const nameFilterTokens = args.nameFilter ? splitFileNameFilterTokens(args.nameFilter) : []
        return await listQuickOpenFiles(
          args.rootPath,
          store,
          args.excludePaths,
          controller?.signal,
          args.maxResults,
          undefined,
          nameFilterTokens.length > 0
            ? (relativePath) => pathMatchesFileNameFilterTokens(relativePath, nameFilterTokens)
            : undefined
        )
      } finally {
        listFilesCancellations.finish(event, args.requestToken, controller)
      }
    }
  )

  ipcMain.handle('fs:cancelListFiles', (event, args: { requestToken: string }): void => {
    listFilesCancellations.cancel(event, args.requestToken)
  })
}
