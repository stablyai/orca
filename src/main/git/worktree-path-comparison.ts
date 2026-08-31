import { posix, win32 } from 'node:path'
import type { GitWorktreeExecOptions } from './worktree-operation-options'
import { translateWslOutputPaths } from './runner'

export function areWorktreePathsEqual(
  leftPath: string,
  rightPath: string,
  platform = process.platform
): boolean {
  if (platform === 'win32' || looksLikeWindowsPath(leftPath) || looksLikeWindowsPath(rightPath)) {
    return (
      win32.normalize(win32.resolve(leftPath)).toLowerCase() ===
      win32.normalize(win32.resolve(rightPath)).toLowerCase()
    )
  }
  return posix.normalize(posix.resolve(leftPath)) === posix.normalize(posix.resolve(rightPath))
}

function looksLikeWindowsPath(pathValue: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(pathValue) || pathValue.startsWith('\\\\')
}

export function resolveRevParsePath(repoPath: string, value: string): string {
  if (posix.isAbsolute(value) || win32.isAbsolute(value)) {
    return value
  }
  // Old git ignores `--path-format=absolute`, so resolve a relative toplevel/git-dir against the scanned repo path.
  return looksLikeWindowsPath(repoPath)
    ? win32.resolve(repoPath, value)
    : posix.resolve(repoPath, value)
}

export function translateWorktreePath(
  worktreePath: string,
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): string {
  const prefix = 'worktree '
  const translated = translateWslOutputPaths(`${prefix}${worktreePath}`, repoPath, options)
  return translated.startsWith(prefix) ? translated.slice(prefix.length) : worktreePath
}
