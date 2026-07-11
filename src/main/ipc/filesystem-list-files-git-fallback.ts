import type { ChildProcess } from 'node:child_process'
import { gitSpawn } from '../git/runner'
import { buildGitLsFilesArgsForQuickOpen } from '../../shared/quick-open-filter'
import {
  createQuickOpenReaddirBudget,
  expandQuickOpenGitFileListing,
  listQuickOpenFilesWithReaddir
} from '../../shared/quick-open-readdir-walk'
import { fileListingCancellationError } from '../../shared/file-listing-cancellation'

/**
 * Fallback file lister using git ls-files. Used when rg is not available.
 *
 * Why two git ls-files calls: the first lists tracked + untracked-but-not-ignored
 * files (mirrors rg --files --hidden with gitignore respect). The second
 * surfaces ignored files (mirrors the second rg call with --no-ignore-vcs).
 */
async function isInsideGitWorkTree(
  rootPath: string,
  localGitOptions: { wslDistro?: string },
  signal?: AbortSignal
): Promise<boolean> {
  if (signal?.aborted) {
    throw fileListingCancellationError(signal)
  }
  return new Promise((resolve, reject) => {
    const child = gitSpawn(['rev-parse', '--is-inside-work-tree'], {
      cwd: rootPath,
      ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
      stdio: ['ignore', 'ignore', 'ignore']
    })
    let done = false
    let timer: ReturnType<typeof setTimeout>
    const cleanup = (): void => {
      clearTimeout(timer)
      child.off('error', handleError)
      child.off('close', handleClose)
      signal?.removeEventListener('abort', handleAbort)
    }
    const finish = (isGitRepo: boolean): void => {
      if (done) {
        return
      }
      done = true
      cleanup()
      resolve(isGitRepo)
    }
    const cancel = (): void => {
      if (done) {
        return
      }
      done = true
      child.kill()
      cleanup()
      reject(fileListingCancellationError(signal))
    }
    const handleError = (): void => finish(false)
    const handleClose = (code: number | null, signal: NodeJS.Signals | null): void =>
      finish(code === 0 && signal === null)
    const handleAbort = (): void => cancel()

    child.once('error', handleError)
    child.once('close', handleClose)
    signal?.addEventListener('abort', handleAbort, { once: true })
    timer = setTimeout(() => {
      child.kill()
      finish(false)
    }, 10_000)
  })
}

export async function listFilesWithGit(
  rootPath: string,
  excludePathPrefixes: readonly string[],
  localGitOptions: { wslDistro?: string },
  signal?: AbortSignal
): Promise<string[]> {
  const isGitWorkTree = await isInsideGitWorkTree(rootPath, localGitOptions, signal)
  if (signal?.aborted) {
    throw fileListingCancellationError(signal)
  }
  if (!isGitWorkTree) {
    return listQuickOpenFilesWithReaddir(rootPath, {
      excludePathPrefixes,
      budget: createQuickOpenReaddirBudget(),
      signal
    })
  }

  const gitPaths = new Set<string>()
  const directoryPaths = new Set<string>()
  const { primary, ignoredPass } = buildGitLsFilesArgsForQuickOpen(excludePathPrefixes)
  const children: {
    child: ChildProcess
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

      // Why: git ls-files outputs paths relative to cwd, so we set cwd to
      // rootPath and use the output directly — no prefix stripping needed.
      const child = gitSpawn(['ls-files', ...args], {
        cwd: rootPath,
        ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let timer: ReturnType<typeof setTimeout>
      const cleanup = (): void => {
        clearTimeout(timer)
        // Why: child.kill() is advisory. If git ignores it, detach our
        // closures so repeated Quick Open attempts do not retain old scans.
        child.stdout!.off('data', handleStdoutData)
        child.stderr!.off('data', handleStderrData)
        child.off('error', handleError)
        child.off('close', handleClose)
      }
      const rejectPass = (err: Error): void => {
        if (done) {
          return
        }
        done = true
        buf = ''
        cleanup()
        reject(err)
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
      const handleStdoutData = (chunk: string): void => {
        buf += chunk
        let start = 0
        let nulIdx = buf.indexOf('\0', start)
        while (nulIdx !== -1) {
          processPath(buf.substring(start, nulIdx))
          start = nulIdx + 1
          nulIdx = buf.indexOf('\0', start)
        }
        buf = start < buf.length ? buf.substring(start) : ''
      }
      const handleStderrData = (): void => {
        /* drain */
      }
      const handleError = (err: Error): void => {
        rejectPass(err)
      }
      const handleClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (done) {
          return
        }
        if (signal) {
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
        rejectPass(new Error(`git ls-files exited with code ${code}`))
      }

      child.stdout!.setEncoding('utf-8')
      child.stdout!.on('data', handleStdoutData)
      child.stderr!.on('data', handleStderrData)
      child.once('error', handleError)
      child.once('close', handleClose)
      timer = setTimeout(() => {
        buf = ''
        child.kill()
        rejectPass(new Error('git ls-files timed out'))
      }, 10000)
    })
  }

  const killSurvivors = (reason = 'git ls-files canceled after sibling failure'): void => {
    // Why: Promise.all rejects on the first failed pass; cancel the sibling so
    // a stuck git process cannot keep scanning after Quick Open has failed.
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

  const onAbort = (): void => killSurvivors('git ls-files cancelled')
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await Promise.all([
      runGitLsFiles(primary),
      // Why: ignored files are supplementary — a failed or timed-out ignored
      // pass must not discard the primary listing the user actually needs
      // (#7719 root cause: the all-or-nothing failure showed zero files).
      // Entries streamed before the failure are kept; a cancelled scan still
      // rejects via the primary pass or the expansion's cancellation check.
      runGitLsFiles(ignoredPass).catch((err: Error) => {
        if (!signal?.aborted) {
          console.warn('[quick-open] git ignored-file pass failed; keeping primary results:', err)
        }
      })
    ])
  } catch (err) {
    killSurvivors()
    if (signal?.aborted) {
      throw fileListingCancellationError(signal)
    }
    throw err
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }

  const files = await expandQuickOpenGitFileListing({
    rootPath,
    gitPaths,
    directoryPaths,
    excludePathPrefixes,
    signal
  })
  // Why: directory placeholders are expanded after Git exits; restore Git's
  // path order so empty queries and fuzzy-score ties remain stable.
  return files.sort()
}
