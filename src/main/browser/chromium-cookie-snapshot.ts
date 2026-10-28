import { mkdtempSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyFileWithWindowsRetry } from '../codex-accounts/fs-utils'

const SNAPSHOT_ATTEMPTS = 5

type FileState = {
  device: bigint
  inode: bigint
  size: bigint
  modifiedAt: bigint
  changedAt: bigint
}

export type ChromiumCookieSnapshot = {
  databasePath: string
  cleanup: () => void
}

type ChromiumCookieSnapshotOptions = {
  tempRoot?: string
  /** Copy's basename; SQLite finds the copied WAL only beside a DB of the same name. */
  fileName?: string
}

function removeSnapshotDirectory(path: string): void {
  // Windows may retain SQLite handles briefly after close; retry snapshot cleanup.
  rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

function readFileState(path: string): FileState | null {
  try {
    const stats = statSync(path, { bigint: true })
    return {
      device: stats.dev,
      inode: stats.ino,
      size: stats.size,
      modifiedAt: stats.mtimeNs,
      changedAt: stats.ctimeNs
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      return null
    }
    throw error
  }
}

function sameFileState(left: FileState | null, right: FileState | null): boolean {
  if (!left || !right) {
    return left === right
  }
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAt === right.modifiedAt &&
    left.changedAt === right.changedAt
  )
}

function removeAttemptFiles(databasePath: string): void {
  for (const suffix of ['', '-wal', '-shm'] as const) {
    try {
      unlinkSync(databasePath + suffix)
    } catch {
      /* best-effort between snapshot attempts */
    }
  }
}

function copyStableAttempt(sourcePath: string, databasePath: string): boolean {
  const sourceWalPath = `${sourcePath}-wal`
  const databaseBefore = readFileState(sourcePath)
  const walBefore = readFileState(sourceWalPath)
  if (!databaseBefore) {
    throw new Error('Chromium cookies database does not exist')
  }

  removeAttemptFiles(databasePath)
  // Retry transient Windows AV/EDR locks; thrown copy errors bypass the snapshot attempt loop.
  copyFileWithWindowsRetry(sourcePath, databasePath)

  if (walBefore) {
    try {
      // SQLite discovers WAL files only under the matching database basename.
      copyFileWithWindowsRetry(sourceWalPath, `${databasePath}-wal`)
    } catch (error) {
      if (isMissingFileError(error)) {
        return false
      }
      throw error
    }
  }
  // Skip the mutable SHM index; SQLite rebuilds it beside the copied WAL.

  const databaseAfter = readFileState(sourcePath)
  const walAfter = readFileState(sourceWalPath)
  if (!sameFileState(databaseBefore, databaseAfter) || !sameFileState(walBefore, walAfter)) {
    return false
  }

  const copiedDatabase = readFileState(databasePath)
  const copiedWal = readFileState(`${databasePath}-wal`)
  return (
    copiedDatabase?.size === databaseBefore.size &&
    (walBefore ? copiedWal?.size === walBefore.size : copiedWal === null)
  )
}

export function createChromiumCookieSnapshot(
  sourcePath: string,
  options: ChromiumCookieSnapshotOptions = {}
): ChromiumCookieSnapshot {
  const snapshotDir = mkdtempSync(join(options.tempRoot ?? tmpdir(), 'orca-cookie-import-'))
  const databasePath = join(snapshotDir, options.fileName ?? 'Cookies')
  let keepSnapshot = false

  try {
    for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
      if (copyStableAttempt(sourcePath, databasePath)) {
        keepSnapshot = true
        return {
          databasePath,
          cleanup: () => removeSnapshotDirectory(snapshotDir)
        }
      }
    }
    throw new Error('Chromium cookies database changed while creating a snapshot')
  } finally {
    if (!keepSnapshot) {
      removeSnapshotDirectory(snapshotDir)
    }
  }
}
