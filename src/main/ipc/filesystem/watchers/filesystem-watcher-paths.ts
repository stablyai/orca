import * as path from 'node:path'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'

function normalizeWatcherRootPath(rootPath: string): string {
  let resolved = isWindowsAbsolutePathLike(rootPath)
    ? path.win32.resolve(rootPath)
    : path.resolve(rootPath)
  // Normalize drive casing so watcher events match stored renderer paths.
  if (/^[a-zA-Z]:/.test(resolved)) {
    resolved = resolved.charAt(0).toUpperCase() + resolved.slice(1)
  }
  return resolved
}

export function getLocalWatcherRoot(rootPath: string): { key: string; path: string } {
  const normalizedPath = normalizeWatcherRootPath(rootPath)
  return {
    // Case-insensitive Windows/UNC keys must match Git's alternate spellings during cleanup.
    key: normalizeRuntimePathForComparison(normalizedPath),
    path: normalizedPath
  }
}

export function normalizeWatcherEventPath(eventPath: string): string {
  let resolved = path.resolve(eventPath)
  if (/^[a-zA-Z]:/.test(resolved)) {
    resolved = resolved.charAt(0).toUpperCase() + resolved.slice(1)
  }
  return resolved
}
