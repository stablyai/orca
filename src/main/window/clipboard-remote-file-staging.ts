import { access, lstat, mkdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import {
  ensureOwnedTempStagingRoot,
  getOwnedTempStagingRoot,
  isDirectChild,
  isMissingPathError,
  isSafeOwnedDirectory,
  removeOwnedDirectory,
  sweepExpiredOwnedDirectories
} from './owned-temp-staging-root'

const REMOTE_CLIPBOARD_STAGING_ROOT_NAME = 'orca-clipboard-files'
const REMOTE_CLIPBOARD_LEGACY_PREFIX = 'orca-clipboard-file-'
const REMOTE_CLIPBOARD_MIGRATION_MARKER = '.legacy-cleanup-complete'
const REMOTE_CLIPBOARD_FILE_TTL_MS = 60 * 60 * 1000
const REMOTE_CLIPBOARD_CLEANUP_RETRY_MS = 60 * 1000
const REMOTE_CLIPBOARD_CLEANUP_RETRY_LIMIT = 3
// Why: compatibility cleanup must never restore O(shared temp root) work.
const REMOTE_CLIPBOARD_LEGACY_ENTRY_LIMIT = 4_096
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const TRANSFER_DIRECTORY_PATTERN = new RegExp(`^\\d{1,16}-${UUID_PATTERN}$`, 'i')
const LEGACY_DIRECTORY_PATTERN = new RegExp(
  `^${REMOTE_CLIPBOARD_LEGACY_PREFIX}\\d{1,16}-${UUID_PATTERN}$`,
  'i'
)
export class RemoteClipboardStagingRootUnsafeError extends Error {
  constructor() {
    super('Remote clipboard staging root is unsafe')
    this.name = 'RemoteClipboardStagingRootUnsafeError'
  }
}

export function getRemoteClipboardStagingRoot(tempRoot: string): string {
  return getOwnedTempStagingRoot(tempRoot, REMOTE_CLIPBOARD_STAGING_ROOT_NAME)
}

export async function createRemoteClipboardTransferDirectory(
  tempRoot: string,
  createdAtMs: number,
  transferId: string
): Promise<string> {
  const stagingRoot = await ensureRemoteClipboardStagingRoot(tempRoot)
  const transferDirectory = join(stagingRoot, `${createdAtMs}-${transferId}`)
  if (
    !isTransferDirectoryName(basename(transferDirectory)) ||
    !isDirectChild(stagingRoot, transferDirectory)
  ) {
    throw new Error('Remote clipboard transfer path escapes its staging root')
  }
  await mkdir(transferDirectory, { mode: 0o700 })
  const transferStats = await lstat(transferDirectory)
  if (!isSafeOwnedDirectory(transferStats)) {
    throw new Error('Remote clipboard transfer directory is unsafe')
  }
  return transferDirectory
}

export async function cleanupExpiredRemoteClipboardStaging(
  tempRoot: string,
  nowMs = Date.now()
): Promise<void> {
  let stagingRoot: string
  try {
    stagingRoot = await ensureRemoteClipboardStagingRoot(tempRoot)
  } catch {
    return
  }
  await sweepExpiredOwnedDirectories(stagingRoot, {
    nowMs,
    ttlMs: REMOTE_CLIPBOARD_FILE_TTL_MS,
    ownsEntry: isTransferDirectoryName
  })
}

export async function cleanupLegacyRemoteClipboardStaging(
  tempRoot: string,
  nowMs = Date.now()
): Promise<void> {
  let stagingRoot: string
  try {
    stagingRoot = await ensureRemoteClipboardStagingRoot(tempRoot)
  } catch {
    return
  }

  const markerPath = join(stagingRoot, REMOTE_CLIPBOARD_MIGRATION_MARKER)
  try {
    await access(markerPath)
    return
  } catch (error) {
    if (!isMissingPathError(error)) {
      return
    }
  }

  const result = await sweepExpiredOwnedDirectories(tempRoot, {
    nowMs,
    ttlMs: REMOTE_CLIPBOARD_FILE_TTL_MS,
    ownsEntry: isLegacyTransferDirectoryName,
    entryLimit: REMOTE_CLIPBOARD_LEGACY_ENTRY_LIMIT
  })
  if (result.complete && !result.hasFreshDirectories && !result.hasFailures) {
    await writeFile(markerPath, '', { flag: 'wx', mode: 0o600 }).catch(() => undefined)
  }
}

export async function removeRemoteClipboardTransferDirectory(
  tempRoot: string,
  transferDirectory: string
): Promise<boolean> {
  const stagingRoot = getRemoteClipboardStagingRoot(tempRoot)
  if (
    !isDirectChild(stagingRoot, transferDirectory) ||
    !isTransferDirectoryName(basename(resolve(transferDirectory)))
  ) {
    return false
  }
  try {
    await ensureRemoteClipboardStagingRoot(tempRoot)
    const transferStats = await lstat(transferDirectory)
    if (!isSafeOwnedDirectory(transferStats)) {
      return false
    }
    await removeOwnedDirectory(transferDirectory)
    return true
  } catch (error) {
    return isMissingPathError(error)
  }
}

export function scheduleRemoteClipboardTransferCleanup(
  tempRoot: string,
  transferDirectory: string
): void {
  scheduleCleanupAttempt(
    tempRoot,
    transferDirectory,
    REMOTE_CLIPBOARD_FILE_TTL_MS,
    REMOTE_CLIPBOARD_CLEANUP_RETRY_LIMIT
  )
}

function scheduleCleanupAttempt(
  tempRoot: string,
  transferDirectory: string,
  delayMs: number,
  retriesRemaining: number
): void {
  const timer = setTimeout(() => {
    void removeRemoteClipboardTransferDirectory(tempRoot, transferDirectory).then((removed) => {
      if (!removed && retriesRemaining > 0) {
        scheduleCleanupAttempt(
          tempRoot,
          transferDirectory,
          REMOTE_CLIPBOARD_CLEANUP_RETRY_MS,
          retriesRemaining - 1
        )
      }
    })
  }, delayMs)
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref()
  }
}

async function ensureRemoteClipboardStagingRoot(tempRoot: string): Promise<string> {
  const stagingRoot = getRemoteClipboardStagingRoot(tempRoot)
  if (!(await ensureOwnedTempStagingRoot(stagingRoot))) {
    throw new RemoteClipboardStagingRootUnsafeError()
  }
  return stagingRoot
}

function isTransferDirectoryName(name: string): boolean {
  return TRANSFER_DIRECTORY_PATTERN.test(name)
}

function isLegacyTransferDirectoryName(name: string): boolean {
  return LEGACY_DIRECTORY_PATTERN.test(name)
}
