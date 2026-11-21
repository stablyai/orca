import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, rmSync, type Stats } from 'node:fs'
import {
  copyFileWithWindowsRetry,
  renameFileWithWindowsRetry
} from '../../shared/file-write/windows-retry-file-operations'

export function writeRollingFileBackup(sourcePath: string, backupPath: string): void {
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
  try {
    // A fresh inode avoids hard-link mutation; rename preserves the old backup on failure.
    copyFileWithWindowsRetry(sourcePath, tempPath)
    if (process.platform === 'win32') {
      // Why: copyFile keeps a read-only attribute, and Windows refuses to rename over a read-only file.
      // On Windows the owner write bit is the read-only attribute; ACLs are untouched.
      for (const path of isReplaceableReadOnlyBackup(existing)
        ? [tempPath, backupPath]
        : [tempPath]) {
        chmodSync(path, 0o666)
      }
    }
    renameFileWithWindowsRetry(tempPath, backupPath)
  } finally {
    rmSync(tempPath, { force: true })
  }
}

/**
 * A read-only Windows backup Orca may make writable before replacing it. A hard-linked one is left
 * alone: clearing its attribute would also change the other file.
 */
export function isReplaceableReadOnlyBackup(backup: Pick<Stats, 'mode' | 'nlink'> | null): boolean {
  return backup !== null && (backup.mode & 0o200) === 0 && backup.nlink === 1
}
