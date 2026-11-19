import { mapSettledWithConcurrency } from '../../shared/concurrency/map-with-concurrency'
// Host deletion needs bounded Windows lock retries and unpatched fs for Electron’s .asar handling.

import { getErrorCode } from '../git/worktrees/worktree-operation-options'
import { unregisteredFolderRefusal } from '../../shared/worktree/removal/removal'
import { join, win32 } from 'node:path'
import { lstat, readdir, rm, rmdir, unlink } from './asar-transparent-fs'
import { isWindowsAbsolutePathLike } from '../../shared/file-access/cross-platform-path'
import { isWslUncPath } from '../../shared/file-access/wsl-paths'
import { stripWin32LongPathPrefix } from '../../shared/file-access/windows-path-access'
import { removeTree } from '../../shared/file-write/windows-transient-lock-removal'

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
  signal?: AbortSignal,
  guard?: (markerGone: boolean) => Promise<void>
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
            const names = await namesExceptCheckoutMarker(root)
            let guardFailure: unknown
            const removeChild = async (name: string) => {
              if (guardFailure) {
                throw guardFailure
              }
              if (guard) {
                try {
                  await guard(false)
                  if (guardFailure) {
                    throw guardFailure
                  }
                } catch (error) {
                  guardFailure = error
                  throw error
                }
              }
              return rm(join(root, name), { recursive: true, force: true })
            }
            const results = guard
              ? await mapSettledWithConcurrency(names, 4, removeChild)
              : await Promise.allSettled(names.map(removeChild))
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
                await guard?.(false)
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
        await guard?.(markerGone)
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

// The volume decides case folding: `.GIT` is the marker only if it is the same file `.git` resolves to.
async function namesExceptCheckoutMarker(root: string): Promise<string[]> {
  const names = await readdir(root)
  if (names.includes('.git')) {
    return names.filter((name) => name !== '.git')
  }
  // A case-folding volume may list the marker under another spelling; only the entry `.git` resolves to is it.
  const marker = await lstat(join(root, '.git')).catch(() => null)
  const kept: string[] = []
  for (const name of names) {
    if (name.toLowerCase() === '.git' && marker) {
      const entry = await lstat(join(root, name)).catch(() => null)
      if (entry && entry.ino === marker.ino && entry.dev === marker.dev) {
        continue
      }
    }
    kept.push(name)
  }
  return kept
}

/** Delete a checkout Git no longer registers, `.git` last, so a failure keeps the link that proves whose folder it is. */
export async function removeUnregisteredHostCheckout(
  targetPath: string,
  signal?: AbortSignal
): Promise<void> {
  let entry
  try {
    entry = await lstat(toHostRemovalPath(targetPath))
  } catch (error) {
    // Like rm -rf, an already-missing folder is done.
    if (getErrorCode(error) === 'ENOENT' || getErrorCode(error) === 'ENOTDIR') {
      return
    }
    throw error
  }
  // lstat never reports a symlink as a directory; following one would empty its target.
  if (!entry.isDirectory()) {
    throw new Error(`Refusing to delete unregistered worktree path: ${targetPath}`)
  }
  await removeHostCheckout(targetPath, async () => true, signal)
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
