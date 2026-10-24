// Host deletion needs Windows lock retries and unpatched fs for Electron’s .asar handling.

import { win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { rm } from './asar-transparent-fs'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import { isWslUncPath } from '../shared/wsl-paths'
import { transientLockRemovalOptions } from '../shared/windows-transient-lock-removal'

const WINDOWS_REMOVE_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000]

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

function isTransientWindowsRemovalError(error: unknown): boolean {
  if (process.platform !== 'win32' || typeof error !== 'object' || error === null) {
    return false
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
  if (code && ['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(code)) {
    return true
  }
  const message = 'message' in error && typeof error.message === 'string' ? error.message : ''
  return /directory not empty|resource busy|operation not permitted/i.test(message)
}

/** Recursively remove a host directory tree, retrying the transient Windows failures. */
export async function removeHostTree(targetPath: string): Promise<void> {
  const removalPath = toHostRemovalPath(targetPath)
  const retryDelays = process.platform === 'win32' ? WINDOWS_REMOVE_RETRY_DELAYS_MS : []
  // Node’s retries absorb transient directory locks before the outer retry loop.
  const rmOptions = transientLockRemovalOptions()
  let attempt = 0

  while (true) {
    try {
      await rm(removalPath, rmOptions)
      return
    } catch (error) {
      if (attempt >= retryDelays.length || !isTransientWindowsRemovalError(error)) {
        throw error
      }
      // Antivirus, indexers, and late handle release can keep just-emptied Windows directories locked.
      await delay(retryDelays[attempt])
      attempt += 1
    }
  }
}
