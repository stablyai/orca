import type { SearchOptions, SearchResult } from '../../shared/types'
import {
  buildGitGrepArgs,
  buildSubmatchRegex,
  createAccumulator,
  finalize,
  ingestGitGrepLine,
  SEARCH_TIMEOUT_MS
} from '../../shared/text-search'
import { gitSpawn } from '../git/runner'

/**
 * Fallback text search using git grep. Used when rg is not available.
 *
 * Why: On Linux, rg may not be installed or may not be in PATH when the app
 * is launched from a desktop entry (which inherits a minimal system PATH).
 * git grep is always available since this is a git-focused app.
 */
export function searchWithGitGrep(
  rootPath: string,
  args: SearchOptions,
  maxResults: number
): Promise<SearchResult> {
  return new Promise((resolve) => {
    const gitArgs = buildGitGrepArgs(args.query, args)
    const matchRegex = buildSubmatchRegex(args.query, args)
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
      const verdict = ingestGitGrepLine(line, rootPath, matchRegex, acc, maxResults)
      if (verdict === 'stop') {
        child.kill()
      }
    }

    const child = gitSpawn(gitArgs, {
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
    child.once('error', () => {
      resolveOnce()
    })
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
