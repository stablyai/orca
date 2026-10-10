import type { ChildProcessHandle } from '@orca/process-host/process-spec'
import type { SearchOptions, SearchResult } from '../../shared/code-search-types'
import { RipgrepSearchDiagnostics } from '../../shared/ripgrep-search-diagnostics'
import { SearchSubprocessLineAccumulator } from '../../shared/search-subprocess-lines'
import { throwIfSignalAborted, abortSignalReason } from '../../shared/abort-signal-reason'
import {
  buildRgArgs,
  createAccumulator,
  DEFAULT_SEARCH_MAX_RESULTS,
  finalize,
  ingestRgJsonLine,
  SEARCH_TIMEOUT_MS
} from '../../shared/text-search'
import {
  absorbPendingRipgrepSpawnError,
  classifySynchronousRipgrepSpawnFailure,
  isRipgrepMissingCwdExit,
  isRipgrepSpawnCwdUsable,
  isRipgrepUnavailableExit,
  isTransientRipgrepSpawnError,
  ripgrepMissingCwdError
} from '../../shared/ripgrep-process-availability'
import { toWindowsWslPath } from '../wsl'
import { bundledRipgrepUnavailableError } from './bundled-ripgrep-path'
import { spawnBundledRipgrep } from './bundled-ripgrep-spawn'
import { stopBundledRipgrep } from './bundled-ripgrep-stop'

export function runBundledRipgrepTextSearch({
  options,
  rootPath,
  resultRootPath,
  wslDistro,
  wslDistroForOutput,
  signal,
  onSpawn
}: {
  options: SearchOptions
  rootPath: string
  resultRootPath: string
  wslDistro?: string
  wslDistroForOutput?: string
  signal?: AbortSignal
  onSpawn: (child: ChildProcessHandle) => () => void
}): Promise<SearchResult> {
  throwIfSignalAborted(signal)
  const maxResults = Math.max(
    1,
    Math.min(options.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS, DEFAULT_SEARCH_MAX_RESULTS)
  )
  return new Promise<SearchResult>((resolvePromise, rejectPromise) => {
    const rgArgs = buildRgArgs(options.query, '.', options)

    const acc = createAccumulator()
    const lines = new SearchSubprocessLineAccumulator()
    const diagnostics = new RipgrepSearchDiagnostics()
    let resolved = false
    let processErrorObserved = false
    let unavailableExitObserved = false
    let child: ChildProcessHandle | null = null
    let killTimeout: ReturnType<typeof setTimeout> | undefined
    let releaseChild: (() => void) | undefined

    const transformAbsPath = wslDistroForOutput
      ? (path: string): string | null =>
          path.includes('\\')
            ? null
            : path.startsWith('/')
              ? toWindowsWslPath(path, wslDistroForOutput)
              : path
      : undefined

    const finish = (result: SearchResult | PromiseLike<SearchResult>): void => {
      if (resolved) {
        return
      }
      resolved = true
      releaseChild?.()
      lines.clear()
      clearTimeout(killTimeout)
      signal?.removeEventListener('abort', onAbort)
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
    const onAbort = (): void => {
      finish(Promise.reject(abortSignalReason(signal!)))
      if (child) {
        stopBundledRipgrep(child, Boolean(wslDistroForOutput))
      }
    }
    const resolveOnce = (code = 0, signal: NodeJS.Signals | null = null): void => {
      const error = diagnostics.failure(code, signal, acc)
      finish(error ? Promise.reject(error) : finalize(acc))
    }
    const rejectUnavailable = (): void => finish(Promise.reject(bundledRipgrepUnavailableError()))
    const processLine = (line: string): void => {
      const verdict = ingestRgJsonLine(line, resultRootPath, acc, maxResults, transformAbsPath)
      if (verdict === 'stop' && child) {
        stopBundledRipgrep(child, Boolean(wslDistroForOutput))
      }
    }

    // A synchronous spawn failure has no child to clean up.
    let nextChild: ReturnType<typeof spawnBundledRipgrep>
    try {
      nextChild = spawnBundledRipgrep(rgArgs, {
        cwd: rootPath,
        wslDistro,
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
    releaseChild = onSpawn(nextChild)

    const handleStdoutData = (chunk: string): void => {
      if (!lines.push(chunk, processLine)) {
        acc.truncated = true
        if (child) {
          stopBundledRipgrep(child, Boolean(wslDistroForOutput))
        }
        resolveOnce()
      }
    }
    const handleStderrData = (chunk: Buffer): void => {
      diagnostics.append(chunk)
    }
    const handleError = (error: NodeJS.ErrnoException): void => {
      processErrorObserved = true
      // Why: fd/process pressure is not a broken install; say so instead of blaming the bundled binary.
      if (isTransientRipgrepSpawnError(error)) {
        finish(Promise.reject(new Error(`rg could not start (${error.code}); try again`)))
        return
      }
      if (child && isRipgrepUnavailableExit(child, null, null)) {
        // Distinguish a missing workspace from a missing binary before close can settle.
        child.off('close', handleClose)
        void isRipgrepSpawnCwdUsable(rootPath)
          .catch(() => true)
          .then((usable) => {
            // A late rejected promise must not escape after close settles the search.
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
      finish(Promise.reject(error))
      if (child) {
        stopBundledRipgrep(child, Boolean(wslDistroForOutput))
      }
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
      const tail = !signal && (code === 0 || code === 1) ? lines.finish() : null
      if (tail !== null) {
        processLine(tail)
      }
      resolveOnce(code ?? -1, signal)
    }

    nextChild.stdout?.setEncoding('utf-8')
    nextChild.stdout?.on('data', handleStdoutData)
    nextChild.stderr?.on('data', handleStderrData)
    nextChild.once('error', handleError)
    nextChild.once('close', handleClose)

    // Why: timeout kills the child mid-scan; mark truncated so the UI shows incomplete results.
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    killTimeout = setTimeout(() => {
      acc.truncated = true
      if (child) {
        stopBundledRipgrep(child, Boolean(wslDistroForOutput))
      }
      resolveOnce()
    }, SEARCH_TIMEOUT_MS)
  })
}
