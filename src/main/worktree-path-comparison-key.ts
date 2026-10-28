import { win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import { canonicalWorktreePath, looksLikePosixAbsolutePath } from './git/worktree-path-comparison'

/** Persisted namespace bytes are frozen, including WSL case folding; use areWorktreePathsEqual for equality. */
export function worktreePathComparisonKey(pathValue: string, platform = process.platform): string {
  if (
    !looksLikePosixAbsolutePath(pathValue) &&
    (platform === 'win32' || isWindowsAbsolutePathLike(pathValue))
  ) {
    return `windows:${win32.normalize(win32.resolve(pathValue)).toLowerCase()}`
  }
  return `posix:${canonicalWorktreePath(pathValue, platform)}`
}
