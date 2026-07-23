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
import {
  buildGitLsFilesArgsForQuickOpen,
  shouldExcludeQuickOpenRelPath,
  shouldIncludeQuickOpenPath
} from '../shared/quick-open-filter'
import {
  expandQuickOpenGitFileListing,
  parseQuickOpenGitLsFilesEntry
} from '../shared/quick-open-readdir-walk'
import {
  buildGitGrepArgs,
  buildSubmatchRegex,
  createAccumulator,
  finalize,
  ingestGitGrepLine,
  SEARCH_TIMEOUT_MS
} from '../shared/text-search'
import { buildRelayGitEnv } from './relay-command-env'
import { SearchSubprocessLineAccumulator } from '../shared/search-subprocess-lines'
import {
  createQuickOpenListingBudget,
  QUICK_OPEN_LISTING_MAX_PATH_BYTES,
  QuickOpenSubprocessPathAccumulator,
  resolveQuickOpenResultLimit,
  retainQuickOpenPath
} from '../shared/quick-open-listing-limits'

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
  options: { signal?: AbortSignal; maxResults?: number } = {}
): Promise<string[]> {
  const { signal, maxResults } = options
  if (signal?.aborted) {
    return Promise.reject(fileListingCancellationError(signal))
  }
  const resultLimit = resolveQuickOpenResultLimit(maxResults)
  if (resultLimit === 0) {
    return Promise.resolve([])
  }
  const gitPaths = new Set<string>()
  const directoryPaths = new Set<string>()
  const directFileCandidates = new Set<string>()
  const listingBudget = createQuickOpenListingBudget()
  const { primary, ignoredPass } = buildGitLsFilesArgsForQuickOpen(excludePathPrefixes)
  const children: {
    child: ReturnType<typeof spawn>
    isDone: () => boolean
    reject: (error: Error) => void
    resolve: () => void
  }[] = []

  const runGitLsFiles = (args: string[]): Promise<void> => {
    return new Promise((resolve, reject) => {
      const paths = new QuickOpenSubprocessPathAccumulator(0)
      let done = false

      const processPath = (path: string): boolean => {
        if (!path) {
          return false
        }
        if (path.endsWith('/')) {
          retainQuickOpenPath(directoryPaths, path, listingBudget)
        } else {
          retainQuickOpenPath(gitPaths, path, listingBudget)
          const parsed = parseQuickOpenGitLsFilesEntry(path)
          const relPath = parsed.path.replace(/\/+$/, '')
          if (
            !parsed.isGitlink &&
            !parsed.isUntrackedDir &&
            shouldIncludeQuickOpenPath(relPath) &&
            !shouldExcludeQuickOpenRelPath(relPath, excludePathPrefixes)
          ) {
            retainQuickOpenPath(directFileCandidates, relPath, listingBudget)
          }
        }
        // Why: placeholders need IO classification and can disappear; only
        // guaranteed final files are allowed to stop the remote Git processes.
        return directFileCandidates.size >= resultLimit
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
        paths.clear()
        cleanup()
        reject(error)
      }
      const resolvePass = (): void => {
        if (done) {
          return
        }
        done = true
        paths.clear()
        cleanup()
        resolve()
      }
      children.push({
        child,
        isDone: () => done,
        reject: rejectPass,
        resolve: resolvePass
      })

      function failForOutput(error: unknown): void {
        child.kill()
        rejectPass(error instanceof Error ? error : new Error(String(error)))
      }
      function handleStdoutData(chunk: Buffer | string): void {
        try {
          const outcome = paths.push(chunk, (path) => !processPath(path))
          if (outcome === 'stopped') {
            finishAtLimit()
          } else if (outcome === 'path-too-large') {
            failForOutput(
              new Error(`Quick Open file path exceeded ${QUICK_OPEN_LISTING_MAX_PATH_BYTES} bytes`)
            )
          }
        } catch (error) {
          failForOutput(error)
        }
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
        try {
          const trailingPath = paths.finish()
          if (trailingPath && processPath(trailingPath)) {
            finishAtLimit()
            return
          }
        } catch (error) {
          failForOutput(error)
          return
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

  function finishAtLimit(): void {
    for (const entry of children) {
      if (entry.isDone()) {
        continue
      }
      entry.resolve()
      if (entry.child.exitCode === null && entry.child.signalCode === null) {
        entry.child.kill()
      }
    }
  }

  // Why: a cancelled scan (workspace switch, superseded request) must stop
  // its git children right away instead of streaming a huge tree the caller
  // has already abandoned over the shared SSH channel.
  const onAbort = (): void => killSurvivors('git ls-files cancelled')
  signal?.addEventListener('abort', onAbort, { once: true })

  const runIgnoredPass = () =>
    // Why: ignored files are supplementary — a failed or timed-out ignored
    // pass must not discard the primary listing the user actually needs.
    runGitLsFiles(ignoredPass).catch((err: Error) => {
      if (!signal?.aborted) {
        console.warn(
          '[relay quick-open] git ignored-file pass failed; keeping primary results:',
          err
        )
      }
    })
  const passes = runGitLsFiles(primary).then(() =>
    directFileCandidates.size < resultLimit ? runIgnoredPass() : Promise.resolve()
  )

  return passes
    .then(async () => {
      const files = await expandQuickOpenGitFileListing({
        rootPath,
        gitPaths,
        directoryPaths,
        excludePathPrefixes,
        signal,
        maxResults: resultLimit
      })
      // Why: directory placeholders are expanded after Git exits; restore
      // Git's path order for empty queries and fuzzy-score ties over SSH.
      return files.sort().slice(0, resultLimit)
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
    const stdoutLines = new SearchSubprocessLineAccumulator()
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

    function handleStdoutData(chunk: Buffer): void {
      if (!stdoutLines.push(chunk, processLine)) {
        acc.truncated = true
        child.kill()
        resolveOnce()
      }
    }

    function handleStderrData(): void {
      /* drain */
    }

    function handleError(): void {
      resolveOnce()
    }

    function handleClose(): void {
      const trailingLine = stdoutLines.finish()
      if (trailingLine !== null) {
        processLine(trailingLine)
      }
      resolveOnce()
    }

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
