import { FileInventoryBudget, FileInventoryCapacityError } from '../../shared/file-inventory-budget'
import { quickOpenListingPathFilter } from '../../shared/quick-open-listing-path-filter'
import { getQuickOpenRgOutputMode } from '../../shared/quick-open-ripgrep-output-mode'
import { RipgrepFilenameDecoder, RipgrepFilenameError } from '../../shared/ripgrep-filename-decoder'
import { sep } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { Store } from '../persistence'
import { toWindowsWslPath } from '../wsl'
import { resolveQuickOpenSearchRoot } from './quick-open-search-root'
import { buildRgArgsForQuickOpen, normalizeQuickOpenRgLine } from '../../shared/quick-open-filter'
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
import { listFilesFromExternalIndex } from '../search/external-workspace-search-provider'

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
  const root = await resolveQuickOpenSearchRoot(rootPath, store, excludePaths)
  const { authorizedRootPath, localGitOptions, excludePathPrefixes, wslDistroForOutput } = root
  const includePath = quickOpenListingPathFilter(excludePathPrefixes, options.candidatePaths)
  const indexed = await listFilesFromExternalIndex(root, {
    ...options,
    maxResults,
    maxSerializedBytes,
    pathFilter,
    signal
  })
  if (indexed) {
    return indexed
  }

  const inventoryBudget =
    maxResults === undefined && maxSerializedBytes === undefined ? new FileInventoryBudget() : null
  const files = new Set<string>()
  let serializedBytes = 2 // []
  const children: {
    child: ChildProcess
    isDone: () => boolean
    finish: (error?: Error) => void
  }[] = []
  // Why: WSL-routed rg can emit Linux-native absolute paths. UNC repos carry
  // their distro in the path; Windows-path repos carry it in project runtime.
  const { primary, ignoredPass } = buildRgArgsForQuickOpen({
    // Why: rg evaluates root-relative exclude globs against cwd only when the
    // search target is cwd-relative. With an absolute target, `!packages/app`
    // filters output after traversal but does not prune the nested worktree.
    searchRoot: '.',
    followSymlinks: options.followSymlinks,
    excludePathPrefixes,
    // On Windows, rg outputs '\\'-separated paths; force '/'. Also force on
    // macOS/Linux for idempotence — it's a no-op there.
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
          wslDistro: localGitOptions.wslDistro,
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
        // Why: treat spawn errors like an abnormal exit — discard residual
        // buffer so a truncated final byte sequence cannot leak as a path.
        buf = ''
        // Why: fd/process pressure is not a broken install; say so instead of blaming the bundled binary.
        if (isTransientRipgrepSpawnError(error)) {
          finish(new Error(`rg could not start (${error.code}); try again`))
          return
        }
        if (isRipgrepUnavailableExit(child, null, null)) {
          // Why the cwd check: spawn reports a missing cwd as ENOENT too, and blaming the binary
          // for it tells the user to reinstall Orca over a workspace that simply moved.
          // Why detach close first: a failed spawn emits error THEN close(code < 0), and close
          // settles synchronously, so this probe would otherwise race it on a sub-millisecond
          // margin -- two measurements disagreed on which wins. Detaching makes it deterministic.
          child.off('close', handleClose)
          // Why catch: a failed probe must not strand the search; fall back to the prior verdict.
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
        // Why first: this code is above rg's own 0/1/2, so the unavailable check would otherwise
        // read an unreachable workspace as a broken install and tell the user to reinstall Orca.
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
          // Why: a signal exit means timeout/OOM/external kill. Returning the
          // already-streamed prefix would recreate the false-empty bug this
          // path is meant to avoid.
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
        // Why: child.kill() is advisory. If rg ignores it, detach our
        // closures so repeated Quick Open attempts do not retain old scans.
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
        // Why: on timeout, the buffer is likely truncated mid-path. Discard
        // it so Quick Open never displays a malformed entry.
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
    // Failed listings must release any process still walking the tree.
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
      // Why: ignored-file output can be much larger and faster than the primary pass; let source
      // files claim every bounded autocomplete budget first, including the transport byte cap.
      await runRg(primary)
      if (
        (maxResults === undefined || files.size < maxResults) &&
        (maxSerializedBytes === undefined || serializedBytes < maxSerializedBytes)
      ) {
        // Why: a filtered scan walks the whole tree; an ignored-pass timeout keeps primary matches.
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
