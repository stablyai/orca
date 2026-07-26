import { copyFileSync, mkdtempSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
}

function removeSnapshotDirectory(path: string): void {
  // Why: Windows can briefly retain SQLite handles after close; bounded retries
  // keep cleanup reliable without ever touching the live browser directory.
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
  copyFileSync(sourcePath, databasePath)

  if (walBefore) {
    try {
      // Why: SQLite only discovers a WAL whose basename exactly matches the DB.
      copyFileSync(sourceWalPath, `${databasePath}-wal`)
    } catch (error) {
      if (isMissingFileError(error)) {
        return false
      }
      throw error
    }
  }
  // Why: SHM is a transient mmap WAL index that may be locked or mid-update.
  // SQLite safely rebuilds a matching Cookies-shm beside the private WAL copy.

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
  const databasePath = join(snapshotDir, 'Cookies')
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
