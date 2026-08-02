import { sep } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { Store } from '../persistence'
import { resolveAuthorizedPath } from './filesystem-auth'
import { checkRgAvailable } from './rg-availability'
import { wslAwareSpawn } from '../git/runner'
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
import { isQuickOpenReaddirBudgetError } from '../../shared/quick-open-readdir-walk'
import { buildInstallRgMessage } from '../../shared/quick-open-install-rg'
import { listFilesWithGit } from './filesystem-list-files-git-fallback'

export async function listQuickOpenFiles(
  rootPath: string,
  store: Store,
  excludePaths?: string[],
  signal?: AbortSignal,
  maxResults?: number
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

  // Why: checking rg availability upfront avoids a race condition where
  // spawn('rg') emits 'close' before 'error' on some platforms, causing
  // the handler to resolve with empty results before the git fallback
  // can run.
  const rgAvailable = await checkRgAvailable(authorizedRootPath, localGitOptions.wslDistro)
  if (!rgAvailable) {
    try {
      return await listFilesWithGit(
        authorizedRootPath,
        excludePathPrefixes,
        localGitOptions,
        signal,
        maxResults
      )
    } catch (err) {
      if (!isQuickOpenReaddirBudgetError(err)) {
        throw err
      }
      throw new Error(await buildInstallRgMessage(err))
    }
  }

  const files = new Set<string>()
  const children: {
    child: ChildProcess
    isDone: () => boolean
    finish: () => void
  }[] = []
  // Why: WSL-routed rg can emit Linux-native absolute paths. UNC repos carry
  // their distro in the path; Windows-path repos carry it in project runtime.
  const wslDistroForOutput = parseWslPath(authorizedRootPath)?.distro ?? localGitOptions.wslDistro

  const { primary, ignoredPass } = buildRgArgsForQuickOpen({
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
        if (maxResults !== undefined && files.size >= maxResults) {
          return true
        }
        files.add(relPath)
        return maxResults !== undefined && files.size >= maxResults
      }

      const child = wslAwareSpawn('rg', args, {
        cwd: authorizedRootPath,
        ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
        stdio: ['ignore', 'pipe', 'pipe']
      })
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
      const handleError = (): void => {
        // Why: treat spawn errors like an abnormal exit — discard residual
        // buffer so a truncated final byte sequence cannot leak as a path.
        buf = ''
        finish(new Error('rg failed to start'))
      }
      const handleClose = (code: number | null, signal: NodeJS.Signals | null): void => {
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
        child.stdout!.off('data', handleStdoutData)
        child.stderr!.off('data', handleStderrData)
        child.off('error', handleError)
        child.off('close', handleClose)
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      }

      children.push({ child, isDone: () => done, finish })

      child.stdout!.setEncoding('utf-8')
      child.stdout!.on('data', handleStdoutData)
      child.stderr!.on('data', handleStderrData)
      child.once('error', handleError)
      child.once('close', handleClose)
      timer = setTimeout(() => {
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
    for (const entry of children) {
      if (entry.isDone()) {
        continue
      }
      entry.finish()
      if (entry.child.exitCode === null && entry.child.signalCode === null) {
        entry.child.kill()
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
        entry.child.kill()
      }
    }
  }

  try {
    if (maxResults === undefined) {
      await Promise.all([runRg(primary), runRg(ignoredPass)])
    } else {
      // Why: ignored-file output can be much larger and faster than the primary
      // pass; let source files claim the bounded autocomplete budget first.
      await runRg(primary)
      if (files.size < maxResults) {
        await runRg(ignoredPass)
      }
    }
  } catch (err) {
    killSurvivors()
    throw err
  }
  return Array.from(files).slice(0, maxResults)
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
