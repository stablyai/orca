import * as path from 'node:path'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync, gitOptionalLocksDisabledEnv } from '../runner'
import { gitRuntimeOptionsKey } from './git-runtime-options-cache-key'
import { iterateNulDelimitedFields } from '../../../shared/nul-delimited-fields'

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
  // Prevent pre-mutation reads from repopulating this cache.
  submodulePathsCacheGeneration += 1
}

export function getSubmodulePathsCacheCountForTests(): number {
  return submodulePathsCache.size
}

function getSubmodulePathsCacheKey(worktreePath: string, options: GitRuntimeOptions): string {
  // Identical paths can name different filesystems across WSL distros.
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

/** Reject submodule paths that escape the parent worktree. */
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

/** Read .gitmodules with a short cache to avoid scanning every index entry. */
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
  // Prune on misses to bound removed-worktree entries while keeping hits O(1).
  pruneExpiredSubmodulePathsCache(now)
  const cacheGeneration = submodulePathsCacheGeneration
  let paths: string[] = []
  try {
    const { stdout } = await gitExecFileAsync(
      ['config', '-z', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'],
      {
        ...gitOptionsForWorktree(worktreePath, options),
        env: gitOptionalLocksDisabledEnv(),
        captureWslLoginShellOutput: true
      }
    )
    for (const record of iterateNulDelimitedFields(stdout)) {
      const separator = record.indexOf('\n')
      if (separator === -1) {
        continue
      }
      const submodulePath = record.slice(separator + 1).replace(/\/+$/, '')
      if (submodulePath) {
        paths.push(submodulePath)
      }
    }
  } catch {
    paths = []
  }
  if (cacheGeneration === submodulePathsCacheGeneration) {
    rememberSubmodulePaths(cacheKey, paths, Date.now())
  }
  return paths
}

export function findContainingSubmodule(submodulePaths: string[], filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '')
  let best: string | null = null
  for (const sub of submodulePaths) {
    if (normalized === sub || normalized.startsWith(`${sub}/`)) {
      if (!best || sub.length > best.length) {
        best = sub
      }
    }
  }
  return best
}
