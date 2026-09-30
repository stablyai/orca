import { sep } from 'node:path'
import type { Store } from '../persistence'
import { fileListingCancellationError } from '../../shared/file-listing-cancellation'
import {
  buildExcludePathPrefixes,
  buildRgArgsForQuickOpen,
  normalizeQuickOpenRgLine,
  shouldExcludeQuickOpenRelPath,
  shouldIncludeQuickOpenPath,
  type RgOutputMode
} from '../../shared/quick-open-filter'
import { isQuickOpenQueryTooLarge, QuickOpenPathRanker } from '../../shared/quick-open-path-search'
import {
  absorbPendingRipgrepSpawnError,
  isRipgrepUnavailableExit,
  classifySynchronousRipgrepSpawnFailure,
  isRipgrepMissingCwdExit,
  isRipgrepSpawnCwdUsable,
  isTransientRipgrepSpawnError,
  killSpawnedRipgrepProcess,
  ripgrepMissingCwdError,
  RipgrepLaunchFailureError,
  RipgrepUnavailableError
} from '../../shared/ripgrep-process-availability'
import { parseWslPath, toWindowsWslPath } from '../wsl'
import { resolveAuthorizedPath } from './filesystem-auth'
import { getLocalGitOptionsForRegisteredWorktree } from './local-worktree-runtime-options'
import { QuickOpenSubprocessPathAccumulator } from '../../shared/quick-open-listing-limits'
import { bundledRipgrepUnavailableError } from '../ripgrep/bundled-ripgrep-path'
import { spawnBundledRipgrep } from '../ripgrep/bundled-ripgrep-spawn'

export type QuickOpenFilePathSearchResult = {
  paths: string[]
  totalCount: number
  truncated: boolean
}

export async function searchQuickOpenFilePaths(
  rootPath: string,
  store: Store,
  args: {
    query: string
    limit: number
    excludePaths?: string[]
    signal?: AbortSignal
  }
): Promise<QuickOpenFilePathSearchResult> {
  if (args.limit <= 0 || !args.query.trim() || isQuickOpenQueryTooLarge(args.query)) {
    return { paths: [], totalCount: 0, truncated: false }
  }
  const authorizedRootPath = await resolveAuthorizedPath(rootPath, store)
  const localGitOptions = getLocalGitOptionsForRegisteredWorktree(
    store,
    rootPath,
    authorizedRootPath
  )
  const wslDistroForOutput = parseWslPath(authorizedRootPath)?.distro ?? localGitOptions.wslDistro

  const excludePathPrefixes = buildExcludePathPrefixes(authorizedRootPath, args.excludePaths)
  const { ignoredPass } = buildRgArgsForQuickOpen({
    searchRoot: '.',
    excludePathPrefixes,
    forceSlashSeparator: sep === '\\'
  })
  // Fresh ranker per attempt so a retry cannot double-count paths from the aborted scan.
  const scanOnce = async (): Promise<QuickOpenFilePathSearchResult> => {
    const ranker = new QuickOpenPathRanker(args.query, args.limit)
    await scanRipgrepPaths({
      args: ignoredPass,
      authorizedRootPath,
      excludePathPrefixes,
      localGitOptions,
      ranker,
      signal: args.signal,
      wslDistroForOutput
    })
    const result = ranker.result()
    return { ...result, truncated: result.totalCount > args.limit }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await scanOnce()
    } catch (error) {
      if (error instanceof RipgrepUnavailableError) {
        throw bundledRipgrepUnavailableError()
      }
      // Why: a supersede that lands after the scan rejected still owes the caller a cancellation.
      if (args.signal?.aborted) {
        throw fileListingCancellationError(args.signal)
      }
      // Why: one-off fork/exec pressure should not blank Quick Open until the query changes.
      if (!(error instanceof RipgrepLaunchFailureError) || attempt > 0) {
        throw error
      }
    }
  }
  throw new Error('unreachable Quick Open retry state')
}

function scanRipgrepPaths(args: {
  args: string[]
  authorizedRootPath: string
  excludePathPrefixes: readonly string[]
  localGitOptions: { wslDistro?: string }
  ranker: QuickOpenPathRanker
  signal?: AbortSignal
  wslDistroForOutput?: string
}): Promise<void> {
  if (args.signal?.aborted) {
    return Promise.reject(fileListingCancellationError(args.signal))
  }
  return new Promise((resolve, reject) => {
    const pathAccumulator = new QuickOpenSubprocessPathAccumulator(0x0a)
    let done = false
    let parseablePathCount = 0
    let processErrorObserved = false
    let unavailableExitObserved = false
    let child: ReturnType<typeof spawnBundledRipgrep>
    try {
      child = spawnBundledRipgrep(args.args, {
        cwd: args.authorizedRootPath,
        wslDistro: args.localGitOptions.wslDistro,
        wslDistroForOutput: args.wslDistroForOutput,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      // Why route through the classifier: a sync throw skips the 'error' handler, and ENOTDIR --
      // a search root that is a file -- should read the same here as it does there.
      void classifySynchronousRipgrepSpawnFailure(error, args.authorizedRootPath).then(
        reject,
        reject
      )
      return
    }
    let timer: ReturnType<typeof setTimeout>

    const processLine = (rawLine: string): void => {
      const translated =
        args.wslDistroForOutput && rawLine.startsWith('/')
          ? toWindowsWslPath(rawLine, args.wslDistroForOutput)
          : rawLine
      const relPath = normalizeQuickOpenRgLine(
        translated,
        getOutputMode(rawLine, translated, args.authorizedRootPath)
      )
      if (relPath === null) {
        return
      }
      parseablePathCount++
      if (
        shouldIncludeQuickOpenPath(relPath) &&
        !shouldExcludeQuickOpenRelPath(relPath, args.excludePathPrefixes)
      ) {
        args.ranker.consider(relPath)
      }
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      child.stdout?.off('data', handleStdoutData)
      child.stderr?.off('data', handleStderrData)
      child.off('error', handleError)
      child.off('close', handleClose)
      args.signal?.removeEventListener('abort', handleAbort)
      absorbPendingRipgrepSpawnError(child, {
        errorObserved: processErrorObserved,
        unavailableExitObserved
      })
    }
    const finish = (error?: Error): void => {
      if (done) {
        return
      }
      done = true
      cleanup()
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const handleStdoutData = (chunk: string): void => {
      pathAccumulator.push(chunk, (path) => {
        processLine(path)
        return true
      })
    }
    const handleStderrData = (): void => {
      /* drain */
    }
    const handleError = (error: NodeJS.ErrnoException): void => {
      processErrorObserved = true
      if (isTransientRipgrepSpawnError(error)) {
        finish(new RipgrepLaunchFailureError(`rg failed to start (${error.code})`))
        return
      }
      if (!isRipgrepUnavailableExit(child, null, null)) {
        finish(new Error(`rg failed to start${error.code ? ` (${error.code})` : ''}`))
        return
      }
      // Why the cwd check: spawn reports a missing cwd as ENOENT too, and blaming the binary
      // for it tells the user to reinstall Orca over a workspace that simply moved.
      // Why detach close first: a failed spawn emits error THEN close(code < 0), and close settles
      // synchronously, so this probe would otherwise race it on a sub-millisecond margin -- two
      // measurements disagreed on which wins. Detaching makes the verdict deterministic.
      child.off('close', handleClose)
      // Why catch: a failed probe must not strand the search; fall back to the prior verdict.
      void isRipgrepSpawnCwdUsable(args.authorizedRootPath)
        .catch(() => true)
        .then((usable) => {
          finish(
            usable ? new RipgrepUnavailableError() : ripgrepMissingCwdError(args.authorizedRootPath)
          )
        })
    }
    const handleClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      // Why before the unavailable check: classifyNativeLauncherExit treats any code above 2 as a
      // broken install, and this code is 97 -- so checking second makes this branch dead.
      if (isRipgrepMissingCwdExit(code)) {
        pathAccumulator.clear()
        finish(ripgrepMissingCwdError(args.authorizedRootPath))
        return
      }
      if (
        isRipgrepUnavailableExit(child, code, signal, {
          classifyNativeLauncherExit: true
        })
      ) {
        unavailableExitObserved = true
        finish(new RipgrepUnavailableError())
        return
      }
      if (signal) {
        finish(new Error(`rg killed by ${signal}`))
        return
      }
      const trailingPath = pathAccumulator.finish()
      if (trailingPath) {
        processLine(trailingPath)
      }
      finish(
        code === 0 || code === 1 || (code === 2 && parseablePathCount > 0)
          ? undefined
          : new Error(`rg exited with code ${code}`)
      )
    }
    const handleAbort = (): void => {
      pathAccumulator.clear()
      killSpawnedRipgrepProcess(child)
      finish(fileListingCancellationError(args.signal))
    }

    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', handleStdoutData)
    child.stderr?.on('data', handleStderrData)
    child.once('error', handleError)
    child.once('close', handleClose)
    args.signal?.addEventListener('abort', handleAbort, { once: true })
    timer = setTimeout(() => {
      pathAccumulator.clear()
      killSpawnedRipgrepProcess(child)
      finish(new Error('rg file-path search timed out'))
    }, 10_000)
    if (args.signal?.aborted) {
      handleAbort()
    }
  })
}

function getOutputMode(rawLine: string, translatedLine: string, rootPath: string): RgOutputMode {
  return translatedLine !== rawLine ||
    rawLine.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(rawLine) ||
    rawLine.startsWith('\\\\')
    ? { kind: 'absolute', rootPath }
    : { kind: 'cwd-relative' }
}
