import * as path from 'node:path'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync, gitOptionalLocksDisabledEnv } from '../runner'
import { gitRuntimeOptionsKey } from './git-runtime-options-cache-key'

const SUBMODULE_PATHS_CACHE_TTL_MS = 5_000
export const MAX_SUBMODULE_PATHS_CACHE_ENTRIES = 512
type SubmodulePathsCacheEntry = { paths: string[]; expiresAt: number }
const submodulePathsCache = new Map<string, SubmodulePathsCacheEntry>()
let submodulePathsCacheGeneration = 0

export function clearSubmodulePathsCacheForTests(): void {
  clearSubmodulePathsCache()
}

export function clearSubmodulePathsCache(): void {
  submodulePathsCache.clear()
  // Why: bump the generation so a pre-mutation read can't repopulate the invalidated cache.
  submodulePathsCacheGeneration += 1
}

export function getSubmodulePathsCacheCountForTests(): number {
  return submodulePathsCache.size
}

function getSubmodulePathsCacheKey(worktreePath: string, options: GitRuntimeOptions): string {
  // Why: the same path can map to different WSL-distro filesystems, so key the cache by runtime routing.
  return [worktreePath, ...gitRuntimeOptionsKey(options)].join('\0')
}

function pruneExpiredSubmodulePathsCache(now: number): void {
  for (const [cacheKey, entry] of submodulePathsCache) {
    if (entry.expiresAt <= now) {
      submodulePathsCache.delete(cacheKey)
    }
  }
}

function trimSubmodulePathsCache(): void {
  while (submodulePathsCache.size > MAX_SUBMODULE_PATHS_CACHE_ENTRIES) {
    const oldestKey = submodulePathsCache.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    submodulePathsCache.delete(oldestKey)
  }
}

function getCachedSubmodulePaths(cacheKey: string, now: number): string[] | null {
  const cached = submodulePathsCache.get(cacheKey)
  if (!cached) {
    return null
  }
  if (cached.expiresAt <= now) {
    submodulePathsCache.delete(cacheKey)
    return null
  }
  submodulePathsCache.delete(cacheKey)
  submodulePathsCache.set(cacheKey, cached)
  return cached.paths
}

function rememberSubmodulePaths(cacheKey: string, paths: string[], now: number): void {
  submodulePathsCache.delete(cacheKey)
  submodulePathsCache.set(cacheKey, { paths, expiresAt: now + SUBMODULE_PATHS_CACHE_TTL_MS })
  trimSubmodulePathsCache()
}

/**
 * Resolve a submodule's own worktree path from a parent worktree + relative
 * submodule path, rejecting anything that escapes the parent.
 */
export function resolveSubmoduleWorktreePath(worktreePath: string, submodulePath: string): string {
  if (!submodulePath || submodulePath.includes('\0') || path.isAbsolute(submodulePath)) {
    throw new Error('Access denied: invalid submodule path')
  }
  const resolved = path.resolve(worktreePath, submodulePath)
  const rel = path.relative(worktreePath, resolved)
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error('Access denied: submodule path escapes the selected worktree')
  }
  return resolved
}

/**
 * List configured submodule paths (relative, forward-slash) for a worktree, cached
 * briefly. Read from `.gitmodules` to avoid an index-wide `ls-files` scan.
 */
export async function listSubmodulePaths(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<string[]> {
  const now = Date.now()
  const cacheKey = getSubmodulePathsCacheKey(worktreePath, options)
  const cached = getCachedSubmodulePaths(cacheKey, now)
  if (cached) {
    return cached
  }
  // Why: prune on misses so removed worktrees don't accumulate; hot hits stay O(1).
  pruneExpiredSubmodulePathsCache(now)
  const cacheGeneration = submodulePathsCacheGeneration
  let paths: string[] = []
  try {
    const { stdout } = await gitExecFileAsync(
      ['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'],
      { ...gitOptionsForWorktree(worktreePath, options), env: gitOptionalLocksDisabledEnv() }
    )
    paths = stdout
      .split(/\r?\n/)
      .map((line) => {
        const spaceIndex = line.indexOf(' ')
        return spaceIndex === -1
          ? ''
          : line
              .slice(spaceIndex + 1)
              .trim()
              .replace(/\/+$/, '')
      })
      .filter((value) => value.length > 0)
  } catch {
    // No .gitmodules (or git config failure) — treat as a repo without submodules.
    paths = []
  }
  if (cacheGeneration === submodulePathsCacheGeneration) {
    rememberSubmodulePaths(cacheKey, paths, Date.now())
  }
  return paths
}

/**
 * Find the submodule whose root equals or contains `filePath`. Returns the
 * submodule path (forward-slash) or null when the path is not in a submodule.
 */
export function findContainingSubmodule(submodulePaths: string[], filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '')
  let best: string | null = null
  for (const sub of submodulePaths) {
    if (normalized === sub || normalized.startsWith(`${sub}/`)) {
      // Prefer the longest match to support nested submodule roots.
      if (!best || sub.length > best.length) {
        best = sub
      }
    }
  }
  return best
}
