import { getQuickOpenRgOutputMode } from '../../shared/quick-open-ripgrep-output-mode'
import { RipgrepFilenameDecoder } from '../../shared/ripgrep-filename-decoder'
import { sep } from 'node:path'
import type { Store } from '../persistence'
import { fileListingCancellationError } from '../../shared/file-listing-cancellation'
import {
  buildRgArgsForQuickOpen,
  normalizeQuickOpenRgLine,
  shouldExcludeQuickOpenRelPath,
  shouldIncludeQuickOpenPath
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
import { toWindowsWslPath } from '../wsl'
import { resolveQuickOpenSearchRoot } from './quick-open-search-root'
import { QuickOpenSubprocessPathAccumulator } from '../../shared/quick-open-listing-limits'
import { bundledRipgrepUnavailableError } from '../ripgrep/bundled-ripgrep-path'
import { spawnBundledRipgrep } from '../ripgrep/bundled-ripgrep-spawn'
import { searchFilePathsFromExternalIndex } from '../search/external-workspace-search-provider'

export type QuickOpenFilePathSearchResult = {
  paths: string[]
  totalCount: number
  truncated: boolean
}

export async function searchQuickOpenFilePaths(
  rootPath: string,
  store: Store,
  args: {
    includeIgnored?: boolean
    followSymlinks?: boolean
    query: string
    limit: number
    excludePaths?: string[]
    signal?: AbortSignal
  }
): Promise<QuickOpenFilePathSearchResult> {
  if (args.limit <= 0 || !args.query.trim() || isQuickOpenQueryTooLarge(args.query)) {
    return { paths: [], totalCount: 0, truncated: false }
  }
  const root = await resolveQuickOpenSearchRoot(rootPath, store, args.excludePaths)
  const { authorizedRootPath, localGitOptions, excludePathPrefixes, wslDistroForOutput } = root
  const indexed = await searchFilePathsFromExternalIndex(root, args)
  if (indexed) {
    return indexed
  }
  const { primary, ignoredPass } = buildRgArgsForQuickOpen({
    searchRoot: '.',
    followSymlinks: args.followSymlinks,
    excludePathPrefixes,
    forceSlashSeparator: sep === '\\'
  })
  // Fresh ranker per attempt so a retry cannot double-count paths from the aborted scan.
  const scanOnce = async (): Promise<QuickOpenFilePathSearchResult> => {
    const ranker = new QuickOpenPathRanker(args.query, args.limit)
    await scanRipgrepPaths({
      args: args.includeIgnored === false ? primary : ignoredPass,
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
    const filenameDecoder = new RipgrepFilenameDecoder((error) => {
      killSpawnedRipgrepProcess(child)
      finish(error)
    }, Boolean(args.wslDistroForOutput))
    const pathAccumulator = new QuickOpenSubprocessPathAccumulator(0)
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
        getQuickOpenRgOutputMode(rawLine, translated, args.authorizedRootPath)
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
    const handleStdoutData = (chunk: Buffer | string): void => {
      const decoded = filenameDecoder.decode(chunk)
      if (decoded === null) {
        return
      }
      const result = pathAccumulator.push(decoded, (path) => {
        processLine(path)
        return true
      })
      if (result === 'path-too-large') {
        killSpawnedRipgrepProcess(child)
        finish(new Error('Quick Open file path exceeds the listing limit'))
      }
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
      if (!filenameDecoder.finish()) {
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
