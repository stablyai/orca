import { sep } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { Store } from '../persistence'
import { resolveAuthorizedPath } from './filesystem-auth'
import { parseWslPath, toWindowsWslPath } from '../wsl'
import { getLocalGitOptionsForRegisteredWorktree } from './local-worktree-runtime-options'
import {
  buildExcludePathPrefixes,
  buildRgArgsForQuickOpen,
  normalizeQuickOpenRgLine,
  type RgOutputMode,
  shouldExcludeQuickOpenRelPath,
  shouldIncludeQuickOpenPath
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
  pathFilter?: (relativePath: string) => boolean
): Promise<string[]> {
  const authorizedRootPath = await resolveAuthorizedPath(rootPath, store)
  const localGitOptions = getLocalGitOptionsForRegisteredWorktree(
    store,
    rootPath,
    authorizedRootPath
  )

  // Why: when the main worktree sits at the repo root, linked worktrees are
  // nested subdirectories. Without excluding them, rg/git lists files from
  // every worktree instead of just the active one. The shared helper
  // normalizes, validates, and root-relativizes every input.
  const excludePathPrefixes = buildExcludePathPrefixes(authorizedRootPath, excludePaths)
  const wslDistroForOutput = parseWslPath(authorizedRootPath)?.distro ?? localGitOptions.wslDistro

  const files = new Set<string>()
  let serializedBytes = 2 // []
  const children: {
    child: ChildProcess
    isDone: () => boolean
    finish: () => void
  }[] = []
  // Why: WSL-routed rg can emit Linux-native absolute paths. UNC repos carry
  // their distro in the path; Windows-path repos carry it in project runtime.
  const rgArgs = buildRgArgsForQuickOpen({
    // Why: rg evaluates root-relative exclude globs against cwd only when the
    // search target is cwd-relative. With an absolute target, `!packages/app`
    // filters output after traversal but does not prune the nested worktree.
    searchRoot: '.',
    excludePathPrefixes,
    // On Windows, rg outputs '\\'-separated paths; force '/'. Also force on
    // macOS/Linux for idempotence — it's a no-op there.
    forceSlashSeparator: sep === '\\'
  })
  const primary = rgArgs.primary
  const ignoredPass = rgArgs.ignoredPass

  const runRg = (args: string[]): Promise<void> => {
    return new Promise((resolve, reject) => {
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
        if (!shouldIncludeQuickOpenPath(relPath)) {
          return false
        }
        if (shouldExcludeQuickOpenRelPath(relPath, excludePathPrefixes)) {
          return false
        }
        if (pathFilter && !pathFilter(relPath)) {
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
      const handleStdoutData = (chunk: string): void => {
        buf += chunk
        let start = 0
        let newlineIdx = buf.indexOf('\n', start)
        while (newlineIdx !== -1) {
          if (processLine(buf.substring(start, newlineIdx))) {
            buf = ''
            finishAtLimit()
            return
          }
          start = newlineIdx + 1
          newlineIdx = buf.indexOf('\n', start)
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
        if (buf && processLine(buf)) {
          buf = ''
          finishAtLimit()
          return
        }
        if (code === 0 || code === 1) {
          finish()
        } else if (code === 2 && parseablePathCount > 0) {
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

      child.stdout?.setEncoding('utf-8')
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
  }

  const killSurvivors = (): void => {
    // Why: if one rg pass fails, Promise.all rejects immediately while the
    // sibling scan can keep walking a huge tree until timeout. Stop it so
    // repeated Quick Open attempts do not accumulate local rg processes.
    for (const entry of children) {
      if (entry.isDone()) {
        continue
      }
      entry.finish()
      if (entry.child.exitCode === null && entry.child.signalCode === null) {
        killSpawnedRipgrepProcess(entry.child)
      }
    }
  }

  function finishAtLimit(): void {
    for (const entry of children) {
      if (entry.isDone()) {
        continue
      }
      entry.finish()
      if (entry.child.exitCode === null && entry.child.signalCode === null) {
        killSpawnedRipgrepProcess(entry.child)
      }
    }
  }
  try {
    const primaryRun = runRg(primary)
    if (maxResults === undefined && maxSerializedBytes === undefined) {
      // Why: a pid-less primary proves launch failure; avoid doubling the failed spawn.
      await (children[0]?.child.pid === undefined
        ? primaryRun
        : Promise.all([primaryRun, runRg(ignoredPass)]))
    } else {
      // Why: ignored-file output can be much larger and faster than the primary pass; let source
      // files claim every bounded autocomplete budget first, including the transport byte cap.
      await primaryRun
      if (
        (maxResults === undefined || files.size < maxResults) &&
        (maxSerializedBytes === undefined || serializedBytes < maxSerializedBytes)
      ) {
        // Why: a filtered scan walks the whole tree; an ignored-pass timeout keeps primary matches.
        await runRg(ignoredPass).catch((err: unknown) => {
          if (!pathFilter || signal?.aborted || err instanceof RipgrepUnavailableError) {
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

function getQuickOpenRgOutputMode(
  rawLine: string,
  translatedLine: string,
  rootPath: string
): RgOutputMode {
  if (
    translatedLine !== rawLine ||
    rawLine.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(rawLine) ||
    rawLine.startsWith('\\\\')
  ) {
    return { kind: 'absolute', rootPath }
  }
  return { kind: 'cwd-relative' }
}
