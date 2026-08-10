import { spawn } from 'node:child_process'
import {
  buildGitGrepArgs,
  buildSubmatchRegex,
  createAccumulator,
  finalize,
  ingestGitGrepLine,
  SEARCH_TIMEOUT_MS
} from '../shared/text-search'
import {
  createTextSearchAbortError,
  throwIfTextSearchAborted
} from '../shared/text-search-cancellation'
import type { SearchOptions, SearchResult } from './fs-handler-utils'
import { buildRelayGitEnv } from './relay-command-env'
import { terminateSpawnedChild } from '../shared/spawned-child-cancellation'

export function searchWithGitGrep(
  rootPath: string,
  query: string,
  opts: SearchOptions,
  signal?: AbortSignal
): Promise<SearchResult> {
  try {
    throwIfTextSearchAborted(signal)
  } catch (error) {
    return Promise.reject(error)
  }
  return new Promise((resolve, reject) => {
    const gitArgs = buildGitGrepArgs(query, opts)
    const matchRegex = buildSubmatchRegex(query, opts)
    const acc = createAccumulator()
    let stdoutBuffer = ''
    let done = false

    const child = spawn('git', gitArgs, {
      cwd: rootPath,
      env: buildRelayGitEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let killTimeout: ReturnType<typeof setTimeout> | null = null

    function cleanup(): void {
      if (killTimeout) {
        clearTimeout(killTimeout)
        killTimeout = null
      }
      child.stdout!.off('data', handleStdoutData)
      child.stderr!.off('data', handleStderrData)
      child.off('error', handleError)
      child.off('close', handleClose)
      signal?.removeEventListener('abort', handleAbort)
    }

    function resolveOnce(options: { kill?: boolean } = {}): void {
      if (done) {
        return
      }
      done = true
      cleanup()
      // Why: kill is advisory over SSH; detach listeners before it can emit close synchronously.
      if (options.kill) {
        terminateSpawnedChild(child)
      }
      resolve(finalize(acc))
    }

    function rejectAborted(): void {
      if (done) {
        return
      }
      done = true
      cleanup()
      terminateSpawnedChild(child)
      reject(createTextSearchAbortError())
    }

    function processLine(line: string): void {
      const verdict = ingestGitGrepLine(line, rootPath, matchRegex, acc, opts.maxResults)
      if (verdict === 'stop') {
        terminateSpawnedChild(child)
      }
    }

    function handleStdoutData(chunk: string): void {
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        processLine(line)
      }
    }

    function handleStderrData(): void {
      /* drain */
    }

    function handleError(): void {
      resolveOnce()
    }

    function handleClose(): void {
      if (stdoutBuffer) {
        processLine(stdoutBuffer)
      }
      resolveOnce()
    }

    function handleAbort(): void {
      rejectAborted()
    }

    child.stdout!.setEncoding('utf-8')
    child.stdout!.on('data', handleStdoutData)
    child.stderr!.on('data', handleStderrData)
    child.once('error', handleError)
    child.once('close', handleClose)

    killTimeout = setTimeout(() => {
      acc.truncated = true
      resolveOnce({ kill: true })
    }, SEARCH_TIMEOUT_MS)
    signal?.addEventListener('abort', handleAbort, { once: true })
    if (signal?.aborted) {
      handleAbort()
    }
  })
}
