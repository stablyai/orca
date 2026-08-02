/**
 * Ripgrep-based file listing for Quick Open.
 * Extracted from fs-handler-utils.ts to keep it under 300 lines (oxlint max-lines).
 *
 * Why a full rewrite vs. the older execFile+maxBuffer version: on a home-dir
 * worktree over SSH, rg descended into every dotfile cache, hit the timeout,
 * and silently resolved with a partial list — Quick Open then showed "No
 * matching files" even though the file existed on disk. This implementation:
 *   - streams via spawn (no maxBuffer failure mode)
 *   - prunes traversal at rg level using the shared blocklist globs
 *   - runs a second --no-ignore-vcs pass for ignored files
 *   - honors excludePathPrefixes for nested linked worktrees
 *   - rejects (not resolves) on timeout / spawn error / signal exit so
 *     the UI shows a load error instead of a false-empty list
 *   - treats rg exit code 2 with parseable stdout as success (permission
 *     denied on a single subdir is expected on home-dir roots)
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { fileListingCancellationError } from '../shared/file-listing-cancellation'
import {
  buildRgArgsForQuickOpen,
  normalizeQuickOpenRgLine,
  shouldExcludeQuickOpenRelPath,
  shouldIncludeQuickOpenPath
} from '../shared/quick-open-filter'

export const LIST_FILES_TIMEOUT_MS = 25_000

export function listFilesWithRg(
  rootPath: string,
  excludePathPrefixes: readonly string[] = [],
  options: { signal?: AbortSignal; maxResults?: number } = {}
): Promise<string[]> {
  const { signal, maxResults } = options
  if (signal?.aborted) {
    return Promise.reject(fileListingCancellationError(signal))
  }
  return new Promise((resolve, reject) => {
    const files = new Set<string>()
    let done = false
    const children: {
      child: ChildProcess
      isDone: () => boolean
      reject: (error: Error) => void
    }[] = []

    const { primary, ignoredPass } = buildRgArgsForQuickOpen({
      // Why: rg only applies root-relative exclude globs as traversal pruning
      // when the search target is relative to cwd. Absolute targets still
      // emit root-relative-looking paths for filters, but they do not prune.
      searchRoot: '.',
      excludePathPrefixes,
      forceSlashSeparator: true
    })

    const processLine = (rawLine: string): boolean => {
      const relPath = normalizeQuickOpenRgLine(rawLine, { kind: 'cwd-relative' })
      if (relPath === null) {
        return false
      }
      // Why: correctness backstop. The rg globs prune most blocklisted dirs,
      // but a glob edge case could still surface e.g. a .git/ or .npm/ hit.
      if (!shouldIncludeQuickOpenPath(relPath)) {
        return true
      }
      if (shouldExcludeQuickOpenRelPath(relPath, excludePathPrefixes)) {
        return true
      }
      files.add(relPath)
      if (maxResults !== undefined && files.size >= maxResults) {
        finishAtLimit()
      }
      return true
    }

    const runPass = (args: string[]): Promise<void> =>
      new Promise((passResolve, passReject) => {
        let passBuf = ''
        let passDone = false
        let passFileCount = 0
        // --no-messages: permission-denied noise on the remote (e.g. .ssh,
        // root-owned mounts) would otherwise flood stderr.
        // cwd: rootPath — root-relative exclude globs like `!packages/app/**`
        // are evaluated against rg's working directory, not the absolute
        // search target. Without cwd, nested-worktree exclusions silently
        // stop working.
        const child = spawn('rg', ['--no-messages', ...args], {
          cwd: rootPath,
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
          if (passDone) {
            return
          }
          passDone = true
          passBuf = ''
          cleanup()
          passReject(error)
        }
        const resolvePass = (): void => {
          if (passDone) {
            return
          }
          passDone = true
          cleanup()
          passResolve()
        }
        children.push({
          child,
          isDone: () => passDone,
          reject: rejectPass
        })

        timer = setTimeout(() => {
          // Discard residual buffer on abnormal exit — a truncated byte
          // sequence could look like a valid path.
          child.kill()
          rejectPass(new Error('rg list timed out'))
        }, LIST_FILES_TIMEOUT_MS)

        function handleStdoutData(chunk: string): void {
          passBuf += chunk
          let start = 0
          let idx = passBuf.indexOf('\n', start)
          while (idx !== -1) {
            if (processLine(passBuf.substring(start, idx))) {
              passFileCount++
            }
            if (done) {
              return
            }
            start = idx + 1
            idx = passBuf.indexOf('\n', start)
          }
          passBuf = start < passBuf.length ? passBuf.substring(start) : ''
        }
        function handleStderrData(): void {
          /* drain to prevent backpressure stalls */
        }
        function handleError(err: Error): void {
          rejectPass(err)
        }
        function handleClose(code: number | null, signal: NodeJS.Signals | null): void {
          if (passDone) {
            return
          }
          // Why signal != null is a failure: the only way spawn gets a signal
          // is if the process was killed (timeout, OOM, external SIGKILL).
          // Trusting its stdout could surface a truncated list as a success.
          if (signal) {
            rejectPass(new Error(`rg killed by ${signal}`))
            return
          }
          // Flush residual line only on clean exit.
          if (passBuf) {
            if (processLine(passBuf)) {
              passFileCount++
            }
          }
          // exit 0 = matches found, 1 = no files (still success for --files).
          // exit 2 is documented as "a subdirectory could not be searched"
          // (e.g. EACCES on .ssh), but rg also returns 2 for fatal errors
          // (bad flag, invalid glob). Only trust exit 2 when rg emitted at
          // least one parseable path — otherwise treat it as a real failure.
          if (code === 0 || code === 1) {
            resolvePass()
          } else if (code === 2 && passFileCount > 0) {
            resolvePass()
          } else {
            rejectPass(new Error(`rg exited with code ${code}`))
          }
        }

        child.stdout!.setEncoding('utf-8')
        child.stdout!.on('data', handleStdoutData)
        child.stderr!.on('data', handleStderrData)
        child.once('error', handleError)
        child.once('close', handleClose)
      })

    const killSurvivors = (reason: string): void => {
      // Why: when one pass rejects, Promise.all surfaces the error immediately
      // but the sibling rg keeps running up to LIST_FILES_TIMEOUT_MS. Kill it
      // so repeated Quick Open opens don't pile up orphan rg processes on the
      // remote.
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
      if (done) {
        return
      }
      done = true
      signal?.removeEventListener('abort', onAbort)
      killSurvivors('rg list reached bounded result limit')
      resolve(Array.from(files).slice(0, maxResults))
    }

    // Why: a cancelled scan (workspace switch, superseded request) must stop
    // its rg children immediately instead of letting them walk the tree to
    // completion and flood the relay with stdout it will only discard.
    const onAbort = (): void => {
      if (done) {
        return
      }
      done = true
      killSurvivors('rg list cancelled')
      reject(fileListingCancellationError(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const passes =
      maxResults === undefined
        ? Promise.all([runPass(primary), runPass(ignoredPass)])
        : // Why: deterministic primary-first budgeting prevents a large ignored
          // tree from starving ordinary source paths on a remote host.
          runPass(primary).then(() =>
            files.size < maxResults ? runPass(ignoredPass) : Promise.resolve()
          )

    passes
      .then(() => {
        if (done) {
          return
        }
        done = true
        signal?.removeEventListener('abort', onAbort)
        resolve(Array.from(files))
      })
      .catch((err) => {
        if (done) {
          return
        }
        done = true
        signal?.removeEventListener('abort', onAbort)
        killSurvivors('rg list canceled after sibling failure')
        reject(err instanceof Error ? err : new Error(String(err)))
      })
  })
}
