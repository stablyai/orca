// Host deletion needs bounded Windows lock retries and unpatched fs for Electron’s .asar handling.

import { getErrorCode } from '../git/worktrees/worktree-operation-options'
import { parseGitdirMarkerPayload } from '../../shared/git/metadata/gitdir-marker-payload'
import {
  differentCheckoutAtPathError,
  unregisteredFolderRefusal
} from '../../shared/worktree/removal/removal'
import { join, win32 } from 'node:path'
import { lstat, lstatBigInt, readUtf8File, readdir, rm, rmdir, unlink } from './asar-transparent-fs'
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

async function deleteHostChildren(root: string, names: readonly string[]): Promise<void> {
  const results = await Promise.allSettled(
    names.map((name) => rm(join(root, name), { recursive: true, force: true }))
  )
  const failures = results.filter((result) => result.status === 'rejected')
  const failure =
    failures.find(({ reason }) => !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(reason?.code)) ??
    failures[0]
  if (failure) {
    throw failure.reason
  }
}

function orNullIfMissing<T>(promise: Promise<T>): Promise<T | null> {
  return promise.catch((error: unknown) => {
    const code = getErrorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null
    }
    throw error
  })
}

async function inspectHostDirectoryRoot(
  root: string,
  targetPath: string,
  initial?: { dev?: bigint; ino?: bigint }
): Promise<{ dev?: bigint; ino?: bigint } | null> {
  const entry = await orNullIfMissing(lstatBigInt(root))
  if (!entry) {
    return null
  }
  if (
    !entry.isDirectory() ||
    (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink())
  ) {
    throw new Error(`Refusing to delete unregistered worktree path: ${targetPath}`)
  }
  if (
    initial?.ino !== undefined &&
    entry.ino !== undefined &&
    (entry.dev !== initial.dev || entry.ino !== initial.ino)
  ) {
    throw differentCheckoutAtPathError(targetPath)
  }
  return entry
}

/** Keep checkout proof out of recursive walks; one shared budget covers children and the final rmdir. */
export async function removeHostCheckout(
  targetPath: string,
  authorize: (checkClean: boolean) => Promise<boolean>,
  signal?: AbortSignal,
  verifyBeforeChildDelete?: () => Promise<boolean>
): Promise<void> {
  const root = toHostRemovalPath(targetPath)
  let initialRoot: { dev?: bigint; ino?: bigint } | undefined
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
            const currentRoot = await inspectHostDirectoryRoot(root, targetPath, initialRoot)
            if (!currentRoot) {
              return
            }
            initialRoot ??= currentRoot
            const names = await namesExceptCheckoutMarker(root)
            if (!(await inspectHostDirectoryRoot(root, targetPath, initialRoot))) {
              return
            }
            if (verifyBeforeChildDelete) {
              markerGone = !(await verifyBeforeChildDelete())
            }
            if (!markerGone) {
              await deleteHostChildren(root, names)
              // Child promises settled; their internal Node sibling walks may still be running.
              markerGone = !(await authorize(false))
              if (!markerGone) {
                if (!(await inspectHostDirectoryRoot(root, targetPath, initialRoot))) {
                  return
                }
                await unlink(join(root, '.git')).catch((error: unknown) => {
                  if (getErrorCode(error) !== 'ENOENT') {
                    throw error
                  }
                })
                markerGone = true
              }
            }
          }
        }
        if (!(await inspectHostDirectoryRoot(root, targetPath, initialRoot))) {
          return
        }
        await removeHostEmptyDirectory(root)
      }
    })
  } catch (error) {
    if (markerGone && getErrorCode(error) === 'ENOTEMPTY') {
      throw (await hasAnyCheckoutMarkerEntry(join(root, '.git')))
        ? differentCheckoutAtPathError(targetPath)
        : unregisteredFolderRefusal(targetPath)
    }
    throw describeRemovalFailure(error)
  }
}

async function hasAnyCheckoutMarkerEntry(markerPath: string): Promise<boolean> {
  return (await orNullIfMissing(lstat(markerPath))) !== null
}

// The volume decides case folding: `.GIT` is the marker only if it is the same file `.git` resolves to.
async function namesExceptCheckoutMarker(root: string): Promise<string[]> {
  const names = await readdir(root)
  if (names.includes('.git')) {
    return names.filter((name) => name !== '.git')
  }
  // A case-folding volume may list the marker under another spelling; only the entry `.git` resolves to is it.
  const marker = await lstatBigInt(join(root, '.git')).catch(() => null)
  const kept: string[] = []
  for (const name of names) {
    if (name.toLowerCase() === '.git' && marker) {
      const entry = await lstatBigInt(join(root, name)).catch(() => null)
      if (entry && entry.ino === marker.ino && entry.dev === marker.dev) {
        continue
      }
    }
    kept.push(name)
  }
  return kept
}

async function inspectHostCheckoutMarker(
  markerPath: string,
  targetPath: string
): Promise<{ identity: string; dev: bigint; ino: bigint } | null> {
  const entry = await orNullIfMissing(lstatBigInt(markerPath))
  if (!entry) {
    return null
  }
  if (!entry.isFile()) {
    throw differentCheckoutAtPathError(targetPath)
  }
  const contents = await orNullIfMissing(readUtf8File(markerPath))
  if (contents === null) {
    return null
  }
  const gitdir = parseGitdirMarkerPayload(contents)
  if (!gitdir) {
    throw differentCheckoutAtPathError(targetPath)
  }
  return { identity: `${gitdir}#${entry.ino}`, dev: entry.dev, ino: entry.ino }
}

/** Delete a checkout Git no longer registers, `.git` last, so a failure keeps the link that proves whose folder it is. */
export async function removeUnregisteredHostCheckout(
  targetPath: string,
  signal?: AbortSignal,
  markerOptions: { expectedMarker?: string; forbidAnyMarker?: boolean } = {}
): Promise<void> {
  const { expectedMarker: expectedMarkerIdentity, forbidAnyMarker = false } = markerOptions
  const root = toHostRemovalPath(targetPath)
  const initialRoot = await inspectHostDirectoryRoot(root, targetPath)
  if (!initialRoot) {
    return
  }

  const markerPath = join(root, '.git')
  const initial = await inspectHostCheckoutMarker(markerPath, targetPath)
  if (
    initial &&
    (forbidAnyMarker ||
      (expectedMarkerIdentity !== undefined && initial.identity !== expectedMarkerIdentity))
  ) {
    throw differentCheckoutAtPathError(targetPath)
  }
  if (initial) {
    const verifyInitialMarker = async (): Promise<boolean> => {
      if (!(await inspectHostDirectoryRoot(root, targetPath, initialRoot))) {
        return false
      }
      const current = await inspectHostCheckoutMarker(markerPath, targetPath)
      if (!current) {
        return false
      }
      if (
        current.dev !== initial.dev ||
        current.ino !== initial.ino ||
        current.identity !== initial.identity
      ) {
        throw differentCheckoutAtPathError(targetPath)
      }
      return true
    }
    await removeHostCheckout(targetPath, verifyInitialMarker, signal, verifyInitialMarker)
    return
  }

  let swept = false
  const assertMarkerlessRoot = async (): Promise<boolean> => {
    if (!(await inspectHostDirectoryRoot(root, targetPath, initialRoot))) {
      return false
    }
    if (await hasAnyCheckoutMarkerEntry(markerPath)) {
      throw differentCheckoutAtPathError(targetPath)
    }
    return true
  }
  try {
    await removeTree(root, {
      signal,
      rm: async () => {
        if (!(await assertMarkerlessRoot())) {
          return
        }
        if (!swept) {
          const names = await namesExceptCheckoutMarker(root)
          if (!(await assertMarkerlessRoot())) {
            return
          }
          await deleteHostChildren(root, names)
          swept = true
          if (!(await assertMarkerlessRoot())) {
            return
          }
        }
        await removeHostEmptyDirectory(root)
      }
    })
  } catch (error) {
    if (swept && getErrorCode(error) === 'ENOTEMPTY') {
      throw (await hasAnyCheckoutMarkerEntry(markerPath))
        ? differentCheckoutAtPathError(targetPath)
        : unregisteredFolderRefusal(targetPath)
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
