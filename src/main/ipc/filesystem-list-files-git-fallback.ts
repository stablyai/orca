import type { ChildProcess } from 'child_process'
import { gitSpawn } from '../git/runner'
import { buildGitLsFilesArgsForQuickOpen } from '../../shared/quick-open-filter'
import {
  createQuickOpenReaddirBudget,
  expandQuickOpenGitFilesWithNestedRepos,
  listQuickOpenFilesWithReaddir
} from '../../shared/quick-open-readdir-walk'

/**
 * Fallback file lister using git ls-files. Used when rg is not available.
 *
 * Why two git ls-files calls: the first lists tracked + untracked-but-not-ignored
 * files (mirrors rg --files --hidden with gitignore respect). The second
 * surfaces ignored files (mirrors the second rg call with --no-ignore-vcs).
 */
async function isInsideGitWorkTree(
  rootPath: string,
  localGitOptions: { wslDistro?: string }
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = gitSpawn(['rev-parse', '--is-inside-work-tree'], {
      cwd: rootPath,
      ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
      stdio: ['ignore', 'ignore', 'ignore']
    })
    let done = false
    let timer: ReturnType<typeof setTimeout>
    const finish = (isGitRepo: boolean): void => {
      if (done) {
        return
      }
      done = true
      clearTimeout(timer)
      child.off('error', handleError)
      child.off('close', handleClose)
      resolve(isGitRepo)
    }
    const handleError = (): void => finish(false)
    const handleClose = (code: number | null, signal: NodeJS.Signals | null): void =>
      finish(code === 0 && signal === null)

    child.once('error', handleError)
    child.once('close', handleClose)
    timer = setTimeout(() => {
      child.kill()
      finish(false)
    }, 10_000)
  })
}

export async function listFilesWithGit(
  rootPath: string,
  excludePathPrefixes: readonly string[],
  localGitOptions: { wslDistro?: string }
): Promise<string[]> {
  if (!(await isInsideGitWorkTree(rootPath, localGitOptions))) {
    return listQuickOpenFilesWithReaddir(rootPath, {
      excludePathPrefixes,
      budget: createQuickOpenReaddirBudget()
    })
  }

  const gitPaths = new Set<string>()
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
        gitPaths.add(path)
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

  const killSurvivors = (): void => {
    // Why: Promise.all rejects on the first failed pass; cancel the sibling so
    // a stuck git process cannot keep scanning after Quick Open has failed.
    for (const entry of children) {
      if (entry.isDone()) {
        continue
      }
      if (entry.child.exitCode === null && entry.child.signalCode === null) {
        entry.child.kill()
      }
      entry.reject(new Error('git ls-files canceled after sibling failure'))
    }
  }

  try {
    await Promise.all([runGitLsFiles(primary), runGitLsFiles(ignoredPass)])
  } catch (err) {
    killSurvivors()
    throw err
  }

  return expandQuickOpenGitFilesWithNestedRepos({
    rootPath,
    gitPaths,
    excludePathPrefixes
  })
}
