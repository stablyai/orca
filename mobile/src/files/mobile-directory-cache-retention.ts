import {
  assertMobileFileDirectoryWithinLimit,
  estimateMobileDirectoryEntryBytes,
  MOBILE_FILE_DIRECTORY_LIMIT_MESSAGE,
  MOBILE_FILE_DIRECTORY_MAX_ENTRIES
} from '../../../src/shared/mobile-file-directory-limit'
import type { DirectoryCache, DirectoryState, MobileDirEntry } from './file-tree'

// Why: old collapsed branches can reload on demand once explorer metadata reaches a phone-safe ceiling.
export const MOBILE_DIRECTORY_CACHE_MAX_DIRECTORIES = 128
export const MOBILE_DIRECTORY_CACHE_MAX_ENTRIES = 25_000
export const MOBILE_DIRECTORY_CACHE_MAX_RETAINED_BYTES = 16 * 1024 * 1024
export const MOBILE_DIRECTORY_CACHE_LIMIT_MESSAGE =
  'Too many folders are open to load this folder safely. Close another folder and retry.'

type CacheLimits = {
  directories: number
  entries: number
  retainedBytes: number
}

type RetentionResult = {
  cache: DirectoryCache
  evictedPaths: string[]
  admitted: boolean
}

const DEFAULT_LIMITS: CacheLimits = {
  directories: MOBILE_DIRECTORY_CACHE_MAX_DIRECTORIES,
  entries: MOBILE_DIRECTORY_CACHE_MAX_ENTRIES,
  retainedBytes: MOBILE_DIRECTORY_CACHE_MAX_RETAINED_BYTES
}

export function parseBoundedMobileDirectoryEntries(value: unknown): MobileDirEntry[] {
  if (!Array.isArray(value)) {
    throw new Error('Desktop returned an invalid folder listing.')
  }
  if (value.length > MOBILE_FILE_DIRECTORY_MAX_ENTRIES) {
    throw new Error(MOBILE_FILE_DIRECTORY_LIMIT_MESSAGE)
  }
  for (const entry of value) {
    if (!isMobileDirectoryEntry(entry)) {
      throw new Error('Desktop returned an invalid folder listing.')
    }
  }
  const entries = value as MobileDirEntry[]
  assertMobileFileDirectoryWithinLimit(entries)
  return entries
}

export function retainMobileDirectoryState(
  cache: DirectoryCache,
  relativePath: string,
  state: DirectoryState,
  expandedPaths: ReadonlySet<string>,
  limits: CacheLimits = DEFAULT_LIMITS
): RetentionResult {
  const next: DirectoryCache = { ...cache, [relativePath]: state }
  const evictedPaths: string[] = []
  const essentialPaths = directoryAncestors(relativePath)

  while (cacheExceedsLimits(next, limits)) {
    const victim = selectEvictionPath(next, expandedPaths, essentialPaths)
    if (victim === null) {
      return { cache, evictedPaths: [], admitted: false }
    }
    for (const path of Object.keys(next)) {
      if (path === victim || path.startsWith(`${victim}/`)) {
        delete next[path]
        evictedPaths.push(path)
      }
    }
  }
  return { cache: next, evictedPaths, admitted: true }
}

export function removeEvictedExpandedPaths(
  expandedPaths: ReadonlySet<string>,
  evictedPaths: readonly string[]
): Set<string> {
  if (evictedPaths.length === 0) {
    return new Set(expandedPaths)
  }
  return new Set(
    [...expandedPaths].filter(
      (expanded) =>
        !evictedPaths.some((evicted) => expanded === evicted || expanded.startsWith(`${evicted}/`))
    )
  )
}

function isMobileDirectoryEntry(value: unknown): value is MobileDirEntry {
  if (!value || typeof value !== 'object') {
    return false
  }
  const entry = value as Record<string, unknown>
  return (
    typeof entry.name === 'string' &&
    typeof entry.isDirectory === 'boolean' &&
    (entry.isSymlink === undefined || typeof entry.isSymlink === 'boolean')
  )
}

function directoryAncestors(relativePath: string): Set<string> {
  const ancestors = new Set(['', relativePath])
  let cursor = relativePath
  while (cursor.includes('/')) {
    cursor = cursor.slice(0, cursor.lastIndexOf('/'))
    ancestors.add(cursor)
  }
  return ancestors
}

function selectEvictionPath(
  cache: DirectoryCache,
  expandedPaths: ReadonlySet<string>,
  essentialPaths: ReadonlySet<string>
): string | null {
  const candidates = Object.keys(cache)
    .filter((path) => !essentialPaths.has(path))
    .sort((left, right) => accessOrder(cache, left) - accessOrder(cache, right))
  return candidates.find((path) => !expandedPaths.has(path)) ?? candidates[0] ?? null
}

function accessOrder(cache: DirectoryCache, path: string): number {
  return cache[path]?.lastAccess ?? 0
}

function cacheExceedsLimits(cache: DirectoryCache, limits: CacheLimits): boolean {
  const paths = Object.keys(cache)
  if (paths.length > limits.directories) {
    return true
  }
  let entries = 0
  let retainedBytes = 0
  for (const path of paths) {
    const state = cache[path]
    if (!state) {
      continue
    }
    entries += state.entries.length
    retainedBytes += estimateDirectoryStateBytes(path, state)
    if (entries > limits.entries || retainedBytes > limits.retainedBytes) {
      return true
    }
  }
  return false
}

function estimateDirectoryStateBytes(path: string, state: DirectoryState): number {
  let bytes = path.length * 2 + (state.error?.length ?? 0) * 2 + 64
  for (const entry of state.entries) {
    bytes += estimateMobileDirectoryEntryBytes(entry)
  }
  return bytes
}
