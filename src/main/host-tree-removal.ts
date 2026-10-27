// Host deletion needs bounded Windows lock retries and unpatched fs for Electron’s .asar handling.

import { win32 } from 'node:path'
import { rm } from './asar-transparent-fs'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import { isWslUncPath } from '../shared/wsl-paths'
import { stripWin32LongPathPrefix } from '../shared/windows-path-access'
import { removeTree } from '../shared/windows-transient-lock-removal'

/** Convert a native host filesystem path to the Win32 long-path namespace. */
export function toHostFilesystemPath(targetPath: string): string {
  // WSL callers supply POSIX paths even on Windows; do not interpret them as drive-relative paths.
  return process.platform === 'win32' &&
    isWindowsAbsolutePathLike(targetPath) &&
    !isWslUncPath(targetPath)
    ? win32.toNamespacedPath(targetPath)
    : targetPath
}

export function toHostRemovalPath(targetPath: string): string {
  // Node deletion uses Win32 long paths even after Git has verified the target.
  return toHostFilesystemPath(targetPath)
}

/** Recursively remove a host directory tree, retrying transient Windows locks as whole passes. */
export async function removeHostTree(
  targetPath: string,
  options: { signal?: AbortSignal } = {}
): Promise<void> {
  try {
    await removeTree(toHostRemovalPath(targetPath), { rm, signal: options.signal })
  } catch (error) {
    throw describeRemovalFailure(error)
  }
}

// Failed-delete rows show this message; name the blocking file instead of Node's error text.
function describeRemovalFailure(error: unknown): unknown {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  const path = error instanceof Error && 'path' in error ? error.path : undefined
  if (path === undefined || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) {
    return error
  }
  const file = stripWin32LongPathPrefix(String(path))
  const message =
    code === 'EBUSY'
      ? `${file} is open in another program. Close that program and delete again.`
      : `${file} could not be deleted; it may be read-only or open in another program. Close any program using it and delete again.`
  return Object.assign(new Error(message, { cause: error }), { code, path: file })
}
