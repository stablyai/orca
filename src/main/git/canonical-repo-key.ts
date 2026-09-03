import { toWslExecutionSpace } from '../../shared/wsl-paths'
import { gitExecFileAsync } from './runner'
import { resolveRevParsePath } from './worktree-path-comparison'

/**
 * One repository on one execution host, named by its Git common dir.
 *
 * Shared by the fetch controller (which serializes fetches on it) and idle ref
 * maintenance (which scopes all of its state to it), so both agree on what "the
 * same repo" means across every worktree that points at it.
 */

export type CanonicalRepoKeyOptions = { wslDistro?: string }

const CACHE_MAX = 512
const cache = new Map<string, string>()

/**
 * Git < 2.31 ignores `--path-format=absolute`: it echoes the unrecognized flag,
 * exits 0, and prints a relative `.git`. Taking the raw stdout there would give
 * every repository on the host the same key.
 */
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
  } catch {
    // The caller path remains a safe serialization key when canonicalization fails.
  }
  return remember(cacheKey, cacheKey)
}

export function _resetCanonicalRepoKeyCacheForTests(): void {
  cache.clear()
}
