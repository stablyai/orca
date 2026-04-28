/**
 * Git-based fallbacks for file listing and text search.
 *
 * Why: the relay depends on ripgrep (rg) for fs.listFiles and fs.search, but
 * rg is not installed on many remote machines. These functions use git ls-files
 * and git grep as universal fallbacks — git is always available since this is
 * a git-focused app.
 */
import { spawn } from 'child_process'
import { type SearchOptions, type SearchResult } from './fs-handler-utils'
import {
  buildGitLsFilesArgsForQuickOpen,
  shouldExcludeQuickOpenRelPath,
  shouldIncludeQuickOpenPath
} from '../shared/quick-open-filter'
import {
  buildGitGrepArgs,
  buildSubmatchRegex,
  createAccumulator,
  finalize,
  ingestGitGrepLine,
  SEARCH_TIMEOUT_MS
} from '../shared/text-search'

/**
 * List files using `git ls-files`. Fallback when rg is not installed.
 *
 * Why both passes: primary surfaces tracked + untracked-non-ignored;
 * envPass surfaces gitignored .env* files that users frequently Quick Open.
 * Exclude pathspecs are prepended by the shared builder so nested linked
 * worktrees are pruned by git directly; post-filtering remains as a
 * correctness backstop.
 */
export function listFilesWithGit(
  rootPath: string,
  excludePathPrefixes: readonly string[] = []
): Promise<string[]> {
  const files = new Set<string>()
  const { primary, envPass } = buildGitLsFilesArgsForQuickOpen(excludePathPrefixes)

  const runGitLsFiles = (args: string[]): Promise<void> => {
    return new Promise((resolve, reject) => {
      let buf = ''
      let done = false

      const processLine = (line: string): void => {
        if (line.charCodeAt(line.length - 1) === 13) {
          line = line.substring(0, line.length - 1)
        }
        if (!line) {
          return
        }
        if (shouldExcludeQuickOpenRelPath(line, excludePathPrefixes)) {
          return
        }
        if (shouldIncludeQuickOpenPath(line)) {
          files.add(line)
        }
      }

      const child = spawn('git', ['ls-files', ...args], {
        cwd: rootPath,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      child.stdout!.setEncoding('utf-8')
      child.stdout!.on('data', (chunk: string) => {
        buf += chunk
        let start = 0
        let idx = buf.indexOf('\n', start)
        while (idx !== -1) {
          processLine(buf.substring(start, idx))
          start = idx + 1
          idx = buf.indexOf('\n', start)
        }
        buf = start < buf.length ? buf.substring(start) : ''
      })
      child.stderr!.on('data', () => {
        /* drain */
      })
      child.once('error', (err) => {
        if (done) {
          return
        }
        done = true
        clearTimeout(timer)
        buf = ''
        reject(err)
      })
      child.once('close', (_code, signal) => {
        if (done) {
          return
        }
        done = true
        clearTimeout(timer)
        if (signal) {
          // Why: a signal exit means the child was killed (timeout or
          // external). Treat that as a load failure rather than silently
          // resolving with whatever git had managed to print.
          buf = ''
          reject(new Error(`git ls-files killed by ${signal}`))
          return
        }
        if (buf) {
          processLine(buf)
        }
        resolve()
      })
      const timer = setTimeout(() => {
        buf = ''
        child.kill()
      }, 10_000)
    })
  }

  return Promise.all([runGitLsFiles(primary), runGitLsFiles(envPass)]).then(() => Array.from(files))
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

    const resolveOnce = (): void => {
      if (done) {
        return
      }
      done = true
      clearTimeout(killTimeout)
      resolve(finalize(acc))
    }

    const processLine = (line: string): void => {
      const verdict = ingestGitGrepLine(line, rootPath, matchRegex, acc, opts.maxResults)
      if (verdict === 'stop') {
        child.kill()
      }
    }

    const child = spawn('git', gitArgs, {
      cwd: rootPath,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout!.setEncoding('utf-8')
    child.stdout!.on('data', (chunk: string) => {
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''
      for (const l of lines) {
        processLine(l)
      }
    })
    child.stderr!.on('data', () => {
      /* drain */
    })
    child.once('error', () => resolveOnce())
    child.once('close', () => {
      if (stdoutBuffer) {
        processLine(stdoutBuffer)
      }
      resolveOnce()
    })

    const killTimeout = setTimeout(() => {
      acc.truncated = true
      child.kill()
    }, SEARCH_TIMEOUT_MS)
  })
}
