// Why: every recursive host delete Orca performs (worktrees, terminal history, quarantined recovery
// generations) hits the same Windows stickiness — AV/indexers/late handle releases surface transient
// EBUSY/ENOTEMPTY/EPERM on a tree Node just emptied. One helper so no call site forgets the retries.

import type { RmOptions } from 'node:fs'
import { rm } from 'node:fs/promises'
import { win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const WINDOWS_REMOVE_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000]
const WINDOWS_RM_MAX_RETRIES = 8
const WINDOWS_RM_RETRY_DELAY_MS = 150

export function toHostRemovalPath(targetPath: string): string {
  // Why: Git for Windows can fail long recursive deletes even after Orca has
  // proven the worktree target; Node's host deletion should use Win32 long paths.
  return process.platform === 'win32' ? win32.toNamespacedPath(targetPath) : targetPath
}

function getHostRemovalOptions(): RmOptions {
  const base = { recursive: true, force: true }
  if (process.platform !== 'win32') {
    return base
  }
  return {
    ...base,
    // Why: large Windows trees commonly surface transient ENOTEMPTY/EPERM while
    // Node walks and removes nested directories.
    maxRetries: WINDOWS_RM_MAX_RETRIES,
    retryDelay: WINDOWS_RM_RETRY_DELAY_MS
  }
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
  const rmOptions = getHostRemovalOptions()
  let attempt = 0

  while (true) {
    try {
      await rm(removalPath, rmOptions)
      return
    } catch (error) {
      if (attempt >= retryDelays.length || !isTransientWindowsRemovalError(error)) {
        throw error
      }
      // Why: Git/Node recursive deletes on Windows can observe a just-emptied
      // directory before antivirus/indexers/handles release it.
      await delay(retryDelays[attempt])
      attempt += 1
    }
  }
}
