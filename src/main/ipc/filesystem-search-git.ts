import type { SearchOptions, SearchResult } from '../../shared/code-search-types'
import {
  buildGitGrepArgs,
  buildSubmatchRegex,
  createAccumulator,
  finalize,
  ingestGitGrepLine,
  SEARCH_TIMEOUT_MS
} from '../../shared/text-search'
import { gitSpawnAfterWindowsEnvironmentReady } from '../git/runner'
import {
  isWslLinkedWorktreeGitRoutingCandidate,
  prepareWslLinkedWorktreeGitRouting
} from '../git/wsl-linked-worktree-git-routing'

/**
 * Fallback text search using git grep. Used when rg is not available.
 *
 * Why: On Linux, rg may not be installed or may not be in PATH when the app
 * is launched from a desktop entry (which inherits a minimal system PATH).
 * git grep is always available since this is a git-focused app.
 */
export async function searchWithGitGrep(
  rootPath: string,
  args: SearchOptions,
  maxResults: number,
  localGitOptions: { wslDistro?: string } = {}
): Promise<SearchResult> {
  if (isWslLinkedWorktreeGitRoutingCandidate(rootPath, localGitOptions.wslDistro)) {
    await prepareWslLinkedWorktreeGitRouting(rootPath, localGitOptions.wslDistro)
  }
  const gitArgs = buildGitGrepArgs(args.query, args)
  const child = await gitSpawnAfterWindowsEnvironmentReady(gitArgs, {
    cwd: rootPath,
    ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return new Promise((resolve) => {
    const matchRegex = buildSubmatchRegex(args.query, args)
    const acc = createAccumulator()
    let stdoutBuffer = ''
    let done = false

    let killTimeout: ReturnType<typeof setTimeout>

    function resolveOnce(): void {
      if (done) {
        return
      }
      done = true
      clearTimeout(killTimeout)
      // Why: child.kill() is advisory. If git ignores it, detach our
      // closures so repeated fallback searches do not retain old scans.
      child.stdout!.off('data', handleStdoutData)
      child.stderr!.off('data', handleStderrData)
      child.off('error', handleError)
      child.off('close', handleClose)
      resolve(finalize(acc))
    }

    function processLine(line: string): void {
      const verdict = ingestGitGrepLine(line, rootPath, matchRegex, acc, maxResults)
      if (verdict === 'stop') {
        child.kill()
      }
    }

    function handleStdoutData(chunk: string): void {
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''
      for (const l of lines) {
        processLine(l)
      }
    }

    function handleStderrData(): void {
      /* drain */
    }

    function handleError(): void {
      resolveOnce()
    }

    function handleClose(): void {
      if (stdoutBuffer) {
        processLine(stdoutBuffer)
      }
      resolveOnce()
    }

    child.stdout!.setEncoding('utf-8')
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
