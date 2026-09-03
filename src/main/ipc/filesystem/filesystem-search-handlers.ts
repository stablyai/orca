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
  isRipgrepUnavailableExit,
  killSpawnedRipgrepProcess
} from '../../../shared/ripgrep-process-availability'
import { toWindowsWslPath, parseWslPath } from '../../wsl'
import { wslAwareSpawn } from '../../git/runner'
import {
  getSshFilesystemProvider,
  requireSshFilesystemProvider
} from '../../providers/ssh-filesystem-dispatch'
import { checkRgAvailable } from '../rg-availability'
import { resolveAuthorizedPath } from '../filesystem-auth'
import { listQuickOpenFiles } from '../filesystem-list-files'
import { searchWithGitGrep } from '../filesystem-search-git'
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
      // Why: WSL's bash exit 127 is ambiguous with a real executable returning 127.
      const wslDistroForOutput = parseWslPath(rootPath)?.distro ?? localGitOptions.wslDistro

      if (wslDistroForOutput && !(await checkRgAvailable(rootPath, localGitOptions.wslDistro))) {
        return searchWithGitGrep(rootPath, args, maxResults, localGitOptions)
      }

      return new Promise<SearchResult>((resolvePromise) => {
        const rgArgs = buildRgArgs(args.query, rootPath, args)
        // Why: kill the prior rg so it stops parsing thousands of matches on the main thread (the large-repo freeze) after the UI moved on.
        const previousChild = activeTextSearches.get(searchKey)
        if (previousChild) {
          killSpawnedRipgrepProcess(previousChild)
        }

        const acc = createAccumulator()
        let stdoutBuffer = ''
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
        const resolveWithoutRipgrep = (): void =>
          finish(searchWithGitGrep(rootPath, args, maxResults, localGitOptions))
        const processLine = (line: string): void => {
          const verdict = ingestRgJsonLine(line, rootPath, acc, maxResults, transformAbsPath)
          if (verdict === 'stop' && child) {
            killSpawnedRipgrepProcess(child)
          }
        }

        const nextChild = wslAwareSpawn('rg', rgArgs, {
          cwd: rootPath,
          ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
          stdio: ['ignore', 'pipe', 'pipe']
        })
        child = nextChild
        activeTextSearches.set(searchKey, nextChild)

        const handleStdoutData = (chunk: string): void => {
          stdoutBuffer += chunk
          const lines = stdoutBuffer.split('\n')
          stdoutBuffer = lines.pop() ?? ''
          for (const line of lines) {
            processLine(line)
          }
        }
        const handleStderrData = (): void => {
          // Drain stderr so rg cannot block on a full pipe.
        }
        const handleError = (): void => {
          processErrorObserved = true
          if (child && isRipgrepUnavailableExit(child, null, null)) {
            resolveWithoutRipgrep()
            return
          }
          resolveOnce()
        }
        const handleClose = (code: number | null, signal: NodeJS.Signals | null): void => {
          if (
            child &&
            isRipgrepUnavailableExit(child, code, signal, {
              classifyNativeLauncherExit: !wslDistroForOutput
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

        nextChild.stdout!.setEncoding('utf-8')
        nextChild.stdout!.on('data', handleStdoutData)
        nextChild.stderr!.on('data', handleStderrData)
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
        return await listQuickOpenFiles(
          args.rootPath,
          store,
          args.excludePaths,
          controller?.signal,
          args.maxResults
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
