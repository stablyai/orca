// Host deletion needs bounded Windows lock retries and unpatched fs for Electron’s .asar handling.

import { getErrorCode } from './git/worktree-operation-options'
import { unregisteredFolderRefusal } from '../shared/worktree/removal'
import { join, win32 } from 'node:path'
import { lstat, readdir, rm, rmdir, unlink } from './asar-transparent-fs'
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

/** Keep checkout proof out of recursive walks; one shared budget covers children and the final rmdir. */
export async function removeHostCheckout(
  targetPath: string,
  authorize: (checkClean: boolean) => Promise<boolean>,
  signal?: AbortSignal
): Promise<void> {
  const root = toHostRemovalPath(targetPath)
  let markerGone = false
  try {
    await removeTree(root, {
      signal,
      rm: async () => {
        if (markerGone) {
          await authorize(false)
        } else {
          markerGone = !(await authorize(true))
          if (!markerGone) {
            const names = (await readdir(root)).filter((name) => name.toLowerCase() !== '.git')
            const results = await Promise.allSettled(
              names.map((name) => rm(join(root, name), { recursive: true, force: true }))
            )
            const failures = results.filter((result) => result.status === 'rejected')
            const failure =
              failures.find(
                ({ reason }) => !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(reason?.code)
              ) ?? failures[0]
            if (failure) {
              throw failure.reason
            }
            // Child promises settled; their internal Node sibling walks may still be running.
            markerGone = !(await authorize(false))
            if (!markerGone) {
              try {
                await unlink(join(root, '.git'))
              } catch (error) {
                if (getErrorCode(error) !== 'ENOENT') {
                  throw error
                }
              }
              markerGone = true
            }
          }
        }
        await removeHostEmptyDirectory(root)
      }
    })
  } catch (error) {
    if (markerGone && getErrorCode(error) === 'ENOTEMPTY') {
      throw unregisteredFolderRefusal(targetPath)
    }
    throw describeRemovalFailure(error)
  }
}

export async function removeHostEmptyDirectory(targetPath: string): Promise<void> {
  const root = toHostRemovalPath(targetPath)
  try {
    await rmdir(root)
  } catch (error) {
    if (getErrorCode(error) !== 'ENOENT') {
      throw error
    }
    // Windows rmdir can report ENOENT for an existing regular-file replacement.
    try {
      await lstat(root)
    } catch (statError) {
      if (getErrorCode(statError) === 'ENOENT') {
        return
      }
      throw statError
    }
    throw error
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
