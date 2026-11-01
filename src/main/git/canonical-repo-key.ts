import type { LocalGitExecOptions } from './repo-default-base-ref'
import type { GitExecOptions } from './command-runner/git-exec-options'
import { toWslExecutionSpace } from '../../shared/wsl-paths'
import { gitExecFileAsync } from './runner'
import { resolveRevParsePath } from './worktree-path-comparison'

/** Fetch serialization and ref maintenance share a host-scoped Git common-dir identity across worktrees. */

export type CanonicalRepoKeyOptions = LocalGitExecOptions &
  Pick<GitExecOptions, 'signal' | 'canStart'>

const CACHE_MAX = 512
const cache = new Map<string, string>()

/** Git < 2.31 echoes unsupported --path-format=absolute; resolve its relative answer to prevent key collisions. */
export function readGitCommonDir(stdout: string, repoPath: string): string | undefined {
  const commonDir = stdout
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .findLast((line) => line.length > 0 && !line.startsWith('-'))
  return commonDir ? resolveRevParsePath(toWslExecutionSpace(repoPath), commonDir) : undefined
}

function remember(cacheKey: string, value: string): string {
  cache.delete(cacheKey)
  cache.set(cacheKey, value)
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next()
    if (oldest.done) {
      break
    }
    cache.delete(oldest.value)
  }
  return value
}

/** `${runtimeKey}::${gitCommonDir}`, falling back to the caller's path. */
export async function getCanonicalRepoKey(
  repoPath: string,
  options: CanonicalRepoKeyOptions = {}
): Promise<string> {
  const runtimeKey = options.wslDistro ? `wsl:${options.wslDistro}` : 'local'
  const cacheKey = `${runtimeKey}::${repoPath}`
  const cached = cache.get(cacheKey)
  if (cached !== undefined) {
    return remember(cacheKey, cached)
  }
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: repoPath, ...options }
    )
    const commonDir = readGitCommonDir(stdout, repoPath)
    if (commonDir) {
      return remember(cacheKey, `${runtimeKey}::${commonDir}`)
    }
  } catch (error) {
    // Cancellation is unavailable identity, not a caller-path identity to cache.
    if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw error
    }
    // The caller path remains a safe serialization key when canonicalization fails.
  }
  return remember(cacheKey, cacheKey)
}

export function _resetCanonicalRepoKeyCacheForTests(): void {
  cache.clear()
}
