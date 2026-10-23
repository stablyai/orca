import { win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import { canonicalWorktreePath, looksLikePosixAbsolutePath } from './git/worktree-path-comparison'

/**
 * Bytes frozen: retirement namespace keys persist this, so a changed fold would orphan saved
 * retired names. That is why a WSL UNC tail still folds here; equality uses `areWorktreePathsEqual`.
 */
export function worktreePathComparisonKey(pathValue: string, platform = process.platform): string {
  if (
    !looksLikePosixAbsolutePath(pathValue) &&
    (platform === 'win32' || isWindowsAbsolutePathLike(pathValue))
  ) {
    return `windows:${win32.normalize(win32.resolve(pathValue)).toLowerCase()}`
  }
  return `posix:${canonicalWorktreePath(pathValue, platform)}`
}
