import { FileInventoryBudget, FileInventoryCapacityError } from '../../shared/file-inventory-budget'
import { quickOpenListingPathFilter } from '../../shared/quick-open-listing-path-filter'
import { getQuickOpenRgOutputMode } from '../../shared/quick-open-ripgrep-output-mode'
import { RipgrepFilenameDecoder, RipgrepFilenameError } from '../../shared/ripgrep-filename-decoder'
import { sep } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { RuntimeStore as Store } from '../runtime/runtime-store-contract'
import { resolveAuthorizedPath } from './filesystem-auth'
import { toWindowsWslPath } from '../wsl'
import { resolveBundledRipgrepWslRouting } from '../ripgrep/bundled-ripgrep-wsl-routing'
import { getLocalGitOptionsForRegisteredWorktree } from './local-worktree-runtime-options'
import {
  buildExcludePathPrefixes,
  buildRgArgsForQuickOpen,
  normalizeQuickOpenRgLine
} from '../../shared/quick-open-filter'
import {
  limitQuickOpenFilesBySerializedBytes,
  serializedQuickOpenPathBytes
} from '../../shared/quick-open-transport-budget'
import { bundledRipgrepUnavailableError } from '../ripgrep/bundled-ripgrep-path'
import { spawnBundledRipgrep } from '../ripgrep/bundled-ripgrep-spawn'
import {
  absorbPendingRipgrepSpawnError,
  isRipgrepUnavailableExit,
  classifySynchronousRipgrepSpawnFailure,
  isRipgrepMissingCwdExit,
  isRipgrepSpawnCwdUsable,
  isTransientRipgrepSpawnError,
  killSpawnedRipgrepProcess,
  ripgrepMissingCwdError,
  RipgrepUnavailableError
} from '../../shared/ripgrep-process-availability'
import { fileListingCancellationError } from '../../shared/file-listing-cancellation'

export async function listQuickOpenFiles(
  rootPath: string,
  store: Store,
  excludePaths?: string[],
  signal?: AbortSignal,
  maxResults?: number,
  maxSerializedBytes?: number,
  /** Applied before `maxResults`, so the cap counts matches rather than scanned files. */
  pathFilter?: (relativePath: string) => boolean,
  options: { includeIgnored?: boolean; followSymlinks?: boolean; candidatePaths?: string[] } = {}
): Promise<string[]> {
  const authorizedRootPath = await resolveAuthorizedPath(rootPath, store)
  const { wslDistro, wslDistroForOutput } = resolveBundledRipgrepWslRouting(
    authorizedRootPath,
    getLocalGitOptionsForRegisteredWorktree(store, rootPath, authorizedRootPath).wslDistro,
    { followSymlinks: options.followSymlinks }
  )

  // Exclude nested linked worktrees so listing the main repo root cannot traverse every checkout.
  const excludePathPrefixes = [
    ...new Set([
      ...buildExcludePathPrefixes(rootPath, excludePaths),
      ...buildExcludePathPrefixes(authorizedRootPath, excludePaths)
    ])
  ]
  const includePath = quickOpenListingPathFilter(excludePathPrefixes, options.candidatePaths)

  const inventoryBudget =
    maxResults === undefined && maxSerializedBytes === undefined ? new FileInventoryBudget() : null
  const files = new Set<string>()
  let serializedBytes = 2
  const children: {
    child: ChildProcess
    isDone: () => boolean
    finish: (error?: Error) => void
  }[] = []
  // WSL rg may emit absolute Linux paths; distro identity comes from UNC paths or project runtime.
  const { primary, ignoredPass } = buildRgArgsForQuickOpen({
    // Use a relative search root so root-relative exclusion globs prune traversal instead of only filtering output.
    searchRoot: '.',
    followSymlinks: options.followSymlinks,
    excludePathPrefixes,
    // Normalize Windows output to forward slashes.
    forceSlashSeparator: sep === '\\'
  })

  const runRg = (args: string[]): Promise<void> =>
    new Promise((resolve, reject) => {
      const filenameDecoder = new RipgrepFilenameDecoder((error) => {
        killSpawnedRipgrepProcess(child)
        finish(error)
      }, Boolean(wslDistroForOutput))
      let buf = ''
      let done = false
      let parseablePathCount = 0
      let processErrorObserved = false
      let unavailableExitObserved = false

      const processLine = (rawLine: string): boolean => {
        const translated =
          wslDistroForOutput && rawLine.startsWith('/')
            ? toWindowsWslPath(rawLine, wslDistroForOutput)
            : rawLine
        const relPath = normalizeQuickOpenRgLine(
          translated,
          getQuickOpenRgOutputMode(rawLine, translated, authorizedRootPath)
        )
        if (relPath === null) {
          return false
        }
        parseablePathCount++
        if (!includePath(relPath) || (pathFilter && !pathFilter(relPath))) {
          return false
        }
        if (files.has(relPath)) {
          return false
        }
        if (maxResults !== undefined && files.size >= maxResults) {
          return true
        }
        if (maxSerializedBytes !== undefined) {
          const nextBytes = serializedQuickOpenPathBytes(relPath) + (files.size === 0 ? 0 : 1)
          if (serializedBytes + nextBytes > maxSerializedBytes) {
            return true
          }
          serializedBytes += nextBytes
        }
        try {
          inventoryBudget?.record(relPath)
        } catch (error) {
          buf = ''
          files.clear()
          killSurvivors(error instanceof Error ? error : new FileInventoryCapacityError())
          return true
        }
        files.add(relPath)
        return maxResults !== undefined && files.size >= maxResults
      }

      // A synchronous spawn failure has no child to clean up.
      let child: ReturnType<typeof spawnBundledRipgrep>
      try {
        child = spawnBundledRipgrep(args, {
          cwd: authorizedRootPath,
          wslDistro,
          wslDistroForOutput,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (error) {
        void classifySynchronousRipgrepSpawnFailure(error, authorizedRootPath).then(reject, reject)
        return
      }
      let timer: ReturnType<typeof setTimeout>
      const handleStdoutData = (chunk: Buffer | string): void => {
        const decoded = filenameDecoder.decode(chunk)
        if (decoded === null) {
          return
        }
        buf += decoded
        let start = 0
        let delimiterIdx = buf.indexOf('\0', start)
        while (delimiterIdx !== -1) {
          if (processLine(buf.substring(start, delimiterIdx))) {
            buf = ''
            killSurvivors()
            return
          }
          start = delimiterIdx + 1
          delimiterIdx = buf.indexOf('\0', start)
        }
        buf = start < buf.length ? buf.substring(start) : ''
      }
      const handleStderrData = (): void => {
        /* drain */
      }
      const handleError = (error: NodeJS.ErrnoException): void => {
        processErrorObserved = true
        // Discard truncated final bytes on spawn errors just as on abnormal exits.
        buf = ''
        // Resource pressure is transient, not a broken bundled installation.
        if (isTransientRipgrepSpawnError(error)) {
          finish(new Error(`rg could not start (${error.code}); try again`))
          return
        }
        if (isRipgrepUnavailableExit(child, null, null)) {
          // ENOENT may mean missing cwd; detach close first so its synchronous failure cannot race the async probe.
          child.off('close', handleClose)
          // A failed cwd probe must not strand the listing; preserve the prior classification.
          void isRipgrepSpawnCwdUsable(authorizedRootPath)
            .catch(() => true)
            .then((usable) => {
              finish(
                usable ? new RipgrepUnavailableError() : ripgrepMissingCwdError(authorizedRootPath)
              )
            })
          return
        }
        finish(new Error('rg failed to start'))
      }
      const handleClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        // WSL missing-cwd codes exceed rg's 0/1/2; classify before the generic unavailable branch.
        if (isRipgrepMissingCwdExit(code)) {
          buf = ''
          finish(ripgrepMissingCwdError(authorizedRootPath))
          return
        }
        if (
          isRipgrepUnavailableExit(child, code, signal, {
            classifyNativeLauncherExit: true
          })
        ) {
          unavailableExitObserved = true
          buf = ''
          finish(new RipgrepUnavailableError())
          return
        }
        if (signal) {
          // Signal exits leave incomplete prefixes; never report them as successful listings.
          buf = ''
          finish(new Error(`rg killed by ${signal}`))
          return
        }
        if (!filenameDecoder.finish()) {
          return
        }
        if (buf && processLine(buf)) {
          buf = ''
          killSurvivors()
          return
        }
        if (code === 0 || code === 1 || (code === 2 && parseablePathCount > 0)) {
          // rg can return 2 for unreadable subdirectories while still listing
          // usable files from the rest of the root.
          finish()
        } else {
          finish(new Error(`rg exited with code ${code}`))
        }
      }
      const finish = (err?: Error): void => {
        if (done) {
          return
        }
        done = true
        clearTimeout(timer)
        // kill is advisory; detach closures so ignored signals cannot retain old scans.
        child.stdout?.off('data', handleStdoutData)
        child.stderr?.off('data', handleStderrData)
        child.off('error', handleError)
        child.off('close', handleClose)
        signal?.removeEventListener('abort', handleAbort)
        absorbPendingRipgrepSpawnError(child, {
          errorObserved: processErrorObserved,
          unavailableExitObserved
        })
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      }
      const handleAbort = (): void => {
        buf = ''
        killSpawnedRipgrepProcess(child)
        finish(fileListingCancellationError(signal))
      }

      children.push({ child, isDone: () => done, finish })

      child.stdout?.on('data', handleStdoutData)
      child.stderr?.on('data', handleStderrData)
      child.once('error', handleError)
      child.once('close', handleClose)
      timer = setTimeout(() => {
        // Discard timeout buffers that may end mid-path.
        buf = ''
        killSpawnedRipgrepProcess(child)
        finish(new Error('rg list timed out'))
      }, 10000)
      signal?.addEventListener('abort', handleAbort, { once: true })
      if (signal?.aborted) {
        handleAbort()
      }
    })

  const killSurvivors = (error?: Error): void => {
    for (const entry of children) {
      if (entry.isDone()) {
        continue
      }
      entry.finish(error)
      if (entry.child.exitCode === null && entry.child.signalCode === null) {
        killSpawnedRipgrepProcess(entry.child)
      }
    }
  }

  try {
    if (options.includeIgnored === false) {
      await runRg(primary)
    } else if (
      options.candidatePaths !== undefined ||
      (maxResults === undefined && maxSerializedBytes === undefined)
    ) {
      // Candidate membership has no primary-first ordering, so one broader pass is enough.
      await runRg(ignoredPass)
    } else {
      // Give source files first claim on bounded result/transport budgets before large ignored-file output.
      await runRg(primary)
      if (
        (maxResults === undefined || files.size < maxResults) &&
        (maxSerializedBytes === undefined || serializedBytes < maxSerializedBytes)
      ) {
        // Keep primary matches if the full-tree ignored pass times out.
        await runRg(ignoredPass).catch((err: unknown) => {
          if (
            !pathFilter ||
            signal?.aborted ||
            err instanceof RipgrepUnavailableError ||
            err instanceof RipgrepFilenameError ||
            err instanceof FileInventoryCapacityError
          ) {
            throw err
          }
        })
      }
    }
  } catch (err) {
    killSurvivors()
    throw err instanceof RipgrepUnavailableError ? bundledRipgrepUnavailableError() : err
  }
  const result = Array.from(files).slice(0, maxResults)
  return maxSerializedBytes === undefined
    ? result
    : limitQuickOpenFilesBySerializedBytes(result, maxSerializedBytes)
}
