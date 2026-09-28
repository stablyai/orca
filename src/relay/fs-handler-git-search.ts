import { SearchSubprocessLineAccumulator } from '../shared/search-subprocess-lines'
import { spawnProcess } from '../shared/child-process/run-process'
import { abortSignalReason } from '../shared/abort-signal-reason'
import type { SearchOptions, SearchResult } from './fs-handler-utils'
import {
  buildGitGrepArgs,
  buildSubmatchRegex,
  createAccumulator,
  finalize,
  ingestGitGrepLine,
  SEARCH_TIMEOUT_MS
} from '../shared/text-search'
import {
  absorbPendingRipgrepSpawnError,
  killSpawnedRipgrepProcess
} from '../shared/ripgrep-process-availability'
import { buildRelayGitEnv } from './relay-command-env'

/**
 * Text search using `git grep`. Fallback when rg is not installed.
 */
export function searchWithGitGrep(
  rootPath: string,
  query: string,
  opts: SearchOptions
): Promise<SearchResult> {
  const { signal } = opts
  if (signal?.aborted) {
    return Promise.reject(abortSignalReason(signal))
  }
  return new Promise((resolve, reject) => {
    const gitArgs = buildGitGrepArgs(query, opts)
    const matchRegex = buildSubmatchRegex(query, opts)
    const acc = createAccumulator()
    const lines = new SearchSubprocessLineAccumulator(Number.MAX_SAFE_INTEGER)
    let done = false
    let processErrorObserved = false

    const child = spawnProcess({
      program: 'git',
      args: gitArgs,
      cwd: rootPath,
      env: buildRelayGitEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let killTimeout: ReturnType<typeof setTimeout>

    function settle(): boolean {
      if (done) {
        return false
      }
      done = true
      signal?.removeEventListener('abort', onAbort)
      lines.clear()
      clearTimeout(killTimeout)
      // Why: child.kill() is advisory. If git ignores it, detach our
      // closures so repeated relay searches do not retain old scans.
      child.stdout!.off('data', handleStdoutData)
      child.stderr!.off('data', handleStderrData)
      child.off('error', handleError)
      child.off('close', handleClose)
      absorbPendingRipgrepSpawnError(child, {
        errorObserved: processErrorObserved,
        unavailableExitObserved: false
      })
      return true
    }

    function resolveOnce(): void {
      if (settle()) {
        resolve(finalize(acc))
      }
    }

    function onAbort(): void {
      if (signal && settle()) {
        try {
          killSpawnedRipgrepProcess(child)
        } catch {
          // A refused kill must still release the canceled request.
        }
        reject(abortSignalReason(signal))
      }
    }

    function processLine(line: string): void {
      const verdict = ingestGitGrepLine(line, rootPath, matchRegex, acc, opts.maxResults)
      if (verdict === 'stop') {
        child.kill()
      }
    }

    function handleStdoutData(chunk: string): void {
      lines.push(chunk, processLine)
    }

    function handleStderrData(): void {
      /* drain */
    }

    function handleError(): void {
      processErrorObserved = true
      resolveOnce()
    }

    function handleClose(): void {
      const tail = lines.finish()
      if (tail !== null) {
        processLine(tail)
      }
      resolveOnce()
    }

    child.stdout!.setEncoding('utf-8')
    child.stdout!.on('data', handleStdoutData)
    child.stderr!.on('data', handleStderrData)
    child.once('error', handleError)
    child.once('close', handleClose)

    killTimeout = setTimeout(() => {
      acc.truncated = true
      child.kill()
      resolveOnce()
    }, SEARCH_TIMEOUT_MS)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
    }
  })
}
