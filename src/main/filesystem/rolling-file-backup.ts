import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, type Stats } from 'node:fs'
import {
  copyFileWithWindowsRetry,
  removeFileWithWindowsRetry,
  renameFileWithWindowsRetry
} from '../../shared/file-write/windows-retry-file-operations'

export function writeRollingFileBackup(sourcePath: string, backupPath: string): void {
  stageRollingFileBackup(sourcePath, backupPath).commit()
}

export type StagedRollingFileBackup = {
  /** Replaces the previous backup with the staged copy. */
  commit: () => void
  /** Drops the staged copy and keeps the previous backup. */
  discard: () => void
}

/** Copies `sourcePath` beside the backup without touching the previous backup until `commit`. */
export function stageRollingFileBackup(
  sourcePath: string,
  backupPath: string
): StagedRollingFileBackup {
  let existing: Stats | null = null
  try {
    const backup = lstatSync(backupPath)
    if (backup.isSymbolicLink()) {
      // copyFile follows destination symlinks and could corrupt an unrelated file.
      throw new Error(`Refusing to overwrite symlinked backup: ${backupPath}`)
    }
    existing = backup
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  const tempPath = `${backupPath}.${process.pid}.${randomUUID()}.tmp`
  const discard = (): void => removeFileWithWindowsRetry(tempPath)
  // Why: Windows refuses to rename over a read-only file. On Windows the owner write bit is the
  // read-only attribute; ACLs are untouched.
  const makeWritable = (path: string): void => {
    if (process.platform === 'win32') {
      chmodSync(path, 0o666)
    }
  }
  try {
    // A fresh inode avoids hard-link mutation; rename preserves the old backup on failure.
    copyFileWithWindowsRetry(sourcePath, tempPath)
    // copyFile keeps the source's read-only attribute.
    makeWritable(tempPath)
  } catch (error) {
    discard()
    throw error
  }
  return {
    commit: () => {
      try {
        // Only now: a discarded stage leaves the previous backup's attribute as it was.
        if (isReplaceableReadOnlyBackup(existing)) {
          makeWritable(backupPath)
        }
        renameFileWithWindowsRetry(tempPath, backupPath)
      } finally {
        discard()
      }
    },
    discard
  }
}

/**
 * A read-only Windows backup Orca may make writable before replacing it. A hard-linked one is left
 * alone: clearing its attribute would also change the other file.
 */
export function isReplaceableReadOnlyBackup(backup: Pick<Stats, 'mode' | 'nlink'> | null): boolean {
  return backup !== null && (backup.mode & 0o200) === 0 && backup.nlink === 1
}
