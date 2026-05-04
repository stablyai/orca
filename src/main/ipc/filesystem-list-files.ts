import { sep } from 'path'
import type { ChildProcess } from 'child_process'
import type { Store } from '../persistence'
import { resolveAuthorizedPath } from './filesystem-auth'
import { checkRgAvailable } from './rg-availability'
import { gitSpawn, wslAwareSpawn } from '../git/runner'
import { parseWslPath, toWindowsWslPath } from '../wsl'
import {
  buildExcludePathPrefixes,
  buildGitLsFilesArgsForQuickOpen,
  buildRgArgsForQuickOpen,
  normalizeQuickOpenRgLine,
  shouldExcludeQuickOpenRelPath,
  shouldIncludeQuickOpenPath
} from '../../shared/quick-open-filter'

export async function listQuickOpenFiles(
  rootPath: string,
  store: Store,
  excludePaths?: string[]
): Promise<string[]> {
  const authorizedRootPath = await resolveAuthorizedPath(rootPath, store)

  // Why: when the main worktree sits at the repo root, linked worktrees are
  // nested subdirectories. Without excluding them, rg/git lists files from
  // every worktree instead of just the active one. The shared helper
  // normalizes, validates, and root-relativizes every input.
  const excludePathPrefixes = buildExcludePathPrefixes(authorizedRootPath, excludePaths)

  // Why: checking rg availability upfront avoids a race condition where
  // spawn('rg') emits 'close' before 'error' on some platforms, causing
  // the handler to resolve with empty results before the git fallback
  // can run.
  const rgAvailable = await checkRgAvailable(authorizedRootPath)
  if (!rgAvailable) {
    return listFilesWithGit(authorizedRootPath, excludePathPrefixes)
  }

  const files = new Set<string>()
  const children: ChildProcess[] = []
  // Why: when rg runs inside WSL, output paths are Linux-native
  // (e.g. /home/user/repo/src/file.ts). Translate them back to Windows
  // UNC paths up-front before the shared line normalizer runs.
  const wslInfo = parseWslPath(authorizedRootPath)

  const { primary, envPass } = buildRgArgsForQuickOpen({
    // Why: rg evaluates root-relative exclude globs against cwd only when the
    // search target is cwd-relative. With an absolute target, `!packages/app`
    // filters output after traversal but does not prune the nested worktree.
    searchRoot: '.',
    excludePathPrefixes,
    // On Windows, rg outputs '\\'-separated paths; force '/'. Also force on
    // macOS/Linux for idempotence — it's a no-op there.
    forceSlashSeparator: sep === '\\'
  })

  const runRg = (args: string[]): Promise<void> => {
    return new Promise((resolve, reject) => {
      let buf = ''
      let done = false
      let parseablePathCount = 0
      const finish = (err?: Error): void => {
        if (done) {
          return
        }
        done = true
        clearTimeout(timer)
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      }

      const processLine = (rawLine: string): void => {
        const translated =
          wslInfo && rawLine.startsWith('/') ? toWindowsWslPath(rawLine, wslInfo.distro) : rawLine
        const relPath = normalizeQuickOpenRgLine(translated, { kind: 'cwd-relative' })
        if (relPath === null) {
          return
        }
        parseablePathCount++
        if (!shouldIncludeQuickOpenPath(relPath)) {
          return
        }
        if (shouldExcludeQuickOpenRelPath(relPath, excludePathPrefixes)) {
          return
        }
        files.add(relPath)
      }

      const child = wslAwareSpawn('rg', args, {
        cwd: authorizedRootPath,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      children.push(child)
      child.stdout!.setEncoding('utf-8')
      child.stdout!.on('data', (chunk: string) => {
        buf += chunk
        let start = 0
        let newlineIdx = buf.indexOf('\n', start)
        while (newlineIdx !== -1) {
          processLine(buf.substring(start, newlineIdx))
          start = newlineIdx + 1
          newlineIdx = buf.indexOf('\n', start)
        }
        buf = start < buf.length ? buf.substring(start) : ''
      })
      child.stderr!.on('data', () => {
        /* drain */
      })
      child.once('error', () => {
        // Why: treat spawn errors like an abnormal exit — discard residual
        // buffer so a truncated final byte sequence cannot leak as a path.
        buf = ''
        finish(new Error('rg failed to start'))
      })
      child.once('close', (code, signal) => {
        if (signal) {
          // Why: a signal exit means timeout/OOM/external kill. Returning the
          // already-streamed prefix would recreate the false-empty bug this
          // path is meant to avoid.
          buf = ''
          finish(new Error(`rg killed by ${signal}`))
          return
        }
        if (buf) {
          processLine(buf)
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
      })
      const timer = setTimeout(() => {
        // Why: on timeout, the buffer is likely truncated mid-path. Discard
        // it so Quick Open never displays a malformed entry.
        buf = ''
        child.kill()
        finish(new Error('rg list timed out'))
      }, 10000)
    })
  }

  const killSurvivors = (): void => {
    // Why: if one rg pass fails, Promise.all rejects immediately while the
    // sibling scan can keep walking a huge tree until timeout. Stop it so
    // repeated Quick Open attempts do not accumulate local rg processes.
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
      }
    }
  }

  try {
    await Promise.all([runRg(primary), runRg(envPass)])
  } catch (err) {
    killSurvivors()
    throw err
  }
  return Array.from(files)
}

/**
 * Fallback file lister using git ls-files. Used when rg is not available.
 *
 * Why two git ls-files calls: the first lists tracked + untracked-but-not-ignored
 * files (mirrors rg --files --hidden with gitignore respect). The second
 * surfaces .env* files that are typically gitignored but users frequently
 * need in quick-open (mirrors the second rg call with --no-ignore-vcs).
 */
function listFilesWithGit(
  rootPath: string,
  excludePathPrefixes: readonly string[]
): Promise<string[]> {
  const files = new Set<string>()
  const { primary, envPass } = buildGitLsFilesArgsForQuickOpen(excludePathPrefixes)

  const runGitLsFiles = (args: string[]): Promise<void> => {
    return new Promise((resolve) => {
      let buf = ''
      let done = false
      const finish = (): void => {
        if (done) {
          return
        }
        done = true
        clearTimeout(timer)
        resolve()
      }

      const processLine = (line: string): void => {
        if (line.charCodeAt(line.length - 1) === 13 /* \r */) {
          line = line.substring(0, line.length - 1)
        }
        if (!line) {
          return
        }
        // Why: git exclude pathspecs prune most hits, but post-filter is
        // still required because pathspec semantics differ subtly from the
        // rg globs and exist as a correctness backstop.
        if (shouldExcludeQuickOpenRelPath(line, excludePathPrefixes)) {
          return
        }
        if (shouldIncludeQuickOpenPath(line)) {
          files.add(line)
        }
      }

      // Why: git ls-files outputs paths relative to cwd, so we set cwd to
      // rootPath and use the output directly — no prefix stripping needed.
      const child = gitSpawn(['ls-files', ...args], {
        cwd: rootPath,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      child.stdout!.setEncoding('utf-8')
      child.stdout!.on('data', (chunk: string) => {
        buf += chunk
        let start = 0
        let newlineIdx = buf.indexOf('\n', start)
        while (newlineIdx !== -1) {
          processLine(buf.substring(start, newlineIdx))
          start = newlineIdx + 1
          newlineIdx = buf.indexOf('\n', start)
        }
        buf = start < buf.length ? buf.substring(start) : ''
      })
      child.stderr!.on('data', () => {
        /* drain */
      })
      child.once('error', () => {
        buf = ''
        finish()
      })
      child.once('close', () => {
        if (buf) {
          processLine(buf)
        }
        finish()
      })
      const timer = setTimeout(() => {
        buf = ''
        child.kill()
      }, 10000)
    })
  }

  return Promise.all([runGitLsFiles(primary), runGitLsFiles(envPass)]).then(() => Array.from(files))
}
