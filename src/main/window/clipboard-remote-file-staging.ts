import type { Dir, Stats } from 'node:fs'
import { access, lstat, mkdir, opendir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

const REMOTE_CLIPBOARD_STAGING_ROOT_NAME = 'orca-clipboard-files'
const REMOTE_CLIPBOARD_LEGACY_PREFIX = 'orca-clipboard-file-'
const REMOTE_CLIPBOARD_MIGRATION_MARKER = '.legacy-cleanup-complete'
const REMOTE_CLIPBOARD_FILE_TTL_MS = 60 * 60 * 1000
const REMOTE_CLIPBOARD_CLEANUP_CONCURRENCY = 8
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
const REMOVE_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 100
} as const

type CleanupResult = 'failed' | 'fresh' | 'ignored' | 'removed'

export class RemoteClipboardStagingRootUnsafeError extends Error {
  constructor() {
    super('Remote clipboard staging root is unsafe')
    this.name = 'RemoteClipboardStagingRootUnsafeError'
  }
}

export function getRemoteClipboardStagingRoot(tempRoot: string): string {
  const uidSuffix = typeof process.getuid === 'function' ? `-${process.getuid()}` : ''
  return join(tempRoot, `${REMOTE_CLIPBOARD_STAGING_ROOT_NAME}${uidSuffix}`)
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
  await sweepDirectories(stagingRoot, nowMs, isTransferDirectoryName)
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

  const result = await sweepDirectories(
    tempRoot,
    nowMs,
    isLegacyTransferDirectoryName,
    REMOTE_CLIPBOARD_LEGACY_ENTRY_LIMIT
  )
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
    await rm(transferDirectory, REMOVE_OPTIONS)
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
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 })
  const rootStats = await lstat(stagingRoot)
  if (!isSafeOwnedDirectory(rootStats)) {
    throw new RemoteClipboardStagingRootUnsafeError()
  }
  return stagingRoot
}

async function sweepDirectories(
  root: string,
  nowMs: number,
  ownsEntry: (name: string) => boolean,
  entryLimit = Number.POSITIVE_INFINITY
): Promise<{ complete: boolean; hasFailures: boolean; hasFreshDirectories: boolean }> {
  let rootDir: Dir
  try {
    rootDir = await opendir(root)
  } catch {
    return { complete: false, hasFailures: false, hasFreshDirectories: false }
  }

  let complete = true
  let entriesVisited = 0
  let hasFailures = false
  let hasFreshDirectories = false
  const pending = new Set<Promise<void>>()
  try {
    for await (const entry of rootDir) {
      entriesVisited += 1
      if (entry.isDirectory() && ownsEntry(entry.name)) {
        const candidate = join(root, entry.name)
        if (isDirectChild(root, candidate)) {
          const cleanup = cleanupDirectory(candidate, nowMs).then((result) => {
            hasFailures ||= result === 'failed'
            hasFreshDirectories ||= result === 'fresh'
          })
          pending.add(cleanup)
          void cleanup.finally(() => pending.delete(cleanup))
          if (pending.size >= REMOTE_CLIPBOARD_CLEANUP_CONCURRENCY) {
            await Promise.race(pending)
          }
        }
      }
      if (entriesVisited >= entryLimit) {
        break
      }
    }
  } catch {
    complete = false
  } finally {
    await rootDir.close().catch(() => undefined)
  }
  await Promise.all(pending)
  return { complete, hasFailures, hasFreshDirectories }
}

async function cleanupDirectory(directory: string, nowMs: number): Promise<CleanupResult> {
  try {
    const directoryStats = await lstat(directory)
    if (!isSafeOwnedDirectory(directoryStats)) {
      return 'ignored'
    }
    if (nowMs - directoryStats.mtimeMs < REMOTE_CLIPBOARD_FILE_TTL_MS) {
      return 'fresh'
    }
    await rm(directory, REMOVE_OPTIONS)
    return 'removed'
  } catch (error) {
    return isMissingPathError(error) ? 'ignored' : 'failed'
  }
}

function isSafeOwnedDirectory(stats: Stats): boolean {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return false
  }
  if (typeof process.getuid !== 'function') {
    return true
  }
  return stats.uid === process.getuid() && (stats.mode & 0o777) === 0o700
}

function isDirectChild(parent: string, candidate: string): boolean {
  return dirname(resolve(candidate)) === resolve(parent)
}

function isTransferDirectoryName(name: string): boolean {
  return TRANSFER_DIRECTORY_PATTERN.test(name)
}

function isLegacyTransferDirectoryName(name: string): boolean {
  return LEGACY_DIRECTORY_PATTERN.test(name)
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}
