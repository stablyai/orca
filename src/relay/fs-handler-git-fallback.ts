/**
 * Git-based fallbacks for file listing and text search.
 *
 * Why: the relay depends on ripgrep (rg) for fs.listFiles and fs.search, but
 * rg is not installed on many remote machines. These functions use git ls-files
 * and git grep as universal fallbacks — git is always available since this is
 * a git-focused app.
 */
import { spawn } from 'node:child_process'
import { fileListingCancellationError } from '../shared/file-listing-cancellation'
import type { SearchOptions, SearchResult } from './fs-handler-utils'
import { buildGitLsFilesArgsForQuickOpen } from '../shared/quick-open-filter'
import { expandQuickOpenGitFileListing } from '../shared/quick-open-readdir-walk'
import {
  buildGitGrepArgs,
  buildSubmatchRegex,
  createAccumulator,
  finalize,
  ingestGitGrepLine,
  SEARCH_TIMEOUT_MS
} from '../shared/text-search'
import { buildRelayGitEnv } from './relay-command-env'

/**
 * List files using `git ls-files`. Fallback when rg is not installed.
 *
 * Why both passes: primary surfaces tracked + untracked-non-ignored;
 * ignoredPass surfaces gitignored files that users frequently Quick Open.
 * Exclude pathspecs are prepended by the shared builder so nested linked
 * worktrees are pruned by git directly; post-filtering remains as a
 * correctness backstop.
 */
export function listFilesWithGit(
  rootPath: string,
  excludePathPrefixes: readonly string[] = [],
  options: { signal?: AbortSignal } = {}
): Promise<string[]> {
  const { signal } = options
  if (signal?.aborted) {
    return Promise.reject(fileListingCancellationError(signal))
  }
  const gitPaths = new Set<string>()
  const directoryPaths = new Set<string>()
  const { primary, ignoredPass } = buildGitLsFilesArgsForQuickOpen(excludePathPrefixes)
  const children: {
    child: ReturnType<typeof spawn>
    isDone: () => boolean
    reject: (error: Error) => void
  }[] = []

  const runGitLsFiles = (args: string[]): Promise<void> => {
    return new Promise((resolve, reject) => {
      let buf = ''
      let done = false

      const processPath = (path: string): void => {
        if (!path) {
          return
        }
        if (path.endsWith('/')) {
          directoryPaths.add(path)
        } else {
          gitPaths.add(path)
        }
      }

      const child = spawn('git', ['ls-files', ...args], {
        cwd: rootPath,
        env: buildRelayGitEnv(),
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let timer: ReturnType<typeof setTimeout> | null = null
      const cleanup = (): void => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        child.stdout!.off('data', handleStdoutData)
        child.stderr!.off('data', handleStderrData)
        child.off('error', handleError)
        child.off('close', handleClose)
      }
      const rejectPass = (error: Error): void => {
        if (done) {
          return
        }
        done = true
        buf = ''
        cleanup()
        reject(error)
      }
      const resolvePass = (): void => {
        if (done) {
          return
        }
        done = true
        cleanup()
        resolve()
      }
      children.push({
        child,
        isDone: () => done,
        reject: rejectPass
      })

      function handleStdoutData(chunk: string): void {
        buf += chunk
        let start = 0
        let idx = buf.indexOf('\0', start)
        while (idx !== -1) {
          processPath(buf.substring(start, idx))
          start = idx + 1
          idx = buf.indexOf('\0', start)
        }
        buf = start < buf.length ? buf.substring(start) : ''
      }
      function handleStderrData(): void {
        /* drain */
      }
      function handleError(err: Error): void {
        rejectPass(err)
      }
      function handleClose(code: number | null, signal: NodeJS.Signals | null): void {
        if (done) {
          return
        }
        if (signal) {
          // Why: a signal exit means the child was killed (timeout or
          // external). Treat that as a load failure rather than silently
          // resolving with whatever git had managed to print.
          rejectPass(new Error(`git ls-files killed by ${signal}`))
          return
        }
        if (buf) {
          processPath(buf)
        }
        if (code === 0) {
          resolvePass()
          return
        }
        // Why: a non-zero exit (e.g. not a git repo) means the listing is
        // incomplete; reject so the caller surfaces the failure instead of
        // expanding a partial result set. Matches the main-process fallback.
        rejectPass(new Error(`git ls-files exited with code ${code}`))
      }

      child.stdout!.setEncoding('utf-8')
      child.stdout!.on('data', handleStdoutData)
      child.stderr!.on('data', handleStderrData)
      child.once('error', handleError)
      child.once('close', handleClose)
      timer = setTimeout(() => {
        child.kill()
        rejectPass(new Error('git ls-files timed out'))
      }, 10_000)
    })
  }

  const killSurvivors = (reason: string): void => {
    // Why: Promise.all returns after the first failed pass, but the sibling
    // git process can keep streaming on SSH unless we cancel it explicitly.
    for (const entry of children) {
      if (entry.isDone()) {
        continue
      }
      if (entry.child.exitCode === null && entry.child.signalCode === null) {
        entry.child.kill()
      }
      entry.reject(new Error(reason))
    }
  }

  // Why: a cancelled scan (workspace switch, superseded request) must stop
  // its git children right away instead of streaming a huge tree the caller
  // has already abandoned over the shared SSH channel.
  const onAbort = (): void => killSurvivors('git ls-files cancelled')
  signal?.addEventListener('abort', onAbort, { once: true })

  return Promise.all([
    runGitLsFiles(primary),
    // Why: ignored files are supplementary — a failed or timed-out ignored
    // pass must not discard the primary listing the user actually needs
    // (#7719 root cause: the all-or-nothing failure showed zero files).
    // Entries streamed before the failure are kept; a cancelled scan still
    // rejects via the primary pass or the expansion's cancellation check.
    runGitLsFiles(ignoredPass).catch((err: Error) => {
      if (!signal?.aborted) {
        console.warn(
          '[relay quick-open] git ignored-file pass failed; keeping primary results:',
          err
        )
      }
    })
  ])
    .then(async () => {
      const files = await expandQuickOpenGitFileListing({
        rootPath,
        gitPaths,
        directoryPaths,
        excludePathPrefixes,
        signal
      })
      // Why: directory placeholders are expanded after Git exits; restore
      // Git's path order for empty queries and fuzzy-score ties over SSH.
      return files.sort()
    })
    .catch((err) => {
      killSurvivors('git ls-files canceled after sibling failure')
      if (signal?.aborted) {
        throw fileListingCancellationError(signal)
      }
      throw err
    })
    .finally(() => {
      signal?.removeEventListener('abort', onAbort)
    })
}

/**
 * Text search using `git grep`. Fallback when rg is not installed.
 */
export function searchWithGitGrep(
  rootPath: string,
  query: string,
  opts: SearchOptions
): Promise<SearchResult> {
  return new Promise((resolve) => {
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
    let killTimeout: ReturnType<typeof setTimeout>

    function resolveOnce(): void {
      if (done) {
        return
      }
      done = true
      clearTimeout(killTimeout)
      // Why: child.kill() is advisory. If git ignores it, detach our
      // closures so repeated relay searches do not retain old scans.
      child.stdout!.off('data', handleStdoutData)
      child.stderr!.off('data', handleStderrData)
      child.off('error', handleError)
      child.off('close', handleClose)
      resolve(finalize(acc))
    }

    function processLine(line: string): void {
      const verdict = ingestGitGrepLine(line, rootPath, matchRegex, acc, opts.maxResults)
      if (verdict === 'stop') {
        child.kill()
      }
    }

    function handleStdoutData(chunk: string): void {
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''
      for (const l of lines) {
        processLine(l)
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
  })
}
