import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, rmSync } from 'node:fs'
import {
  copyFileWithWindowsRetry,
  renameFileWithWindowsRetry
} from '../../shared/file-write/windows-retry-file-operations'

export function writeRollingFileBackup(sourcePath: string, backupPath: string): void {
  let backupMode: number | null = null
  try {
    const backup = lstatSync(backupPath)
    if (backup.isSymbolicLink()) {
      // copyFile follows destination symlinks and could corrupt an unrelated file.
      throw new Error(`Refusing to overwrite symlinked backup: ${backupPath}`)
    }
    backupMode = backup.mode
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
      clearWindowsReadOnly(tempPath)
      if (backupMode !== null && (backupMode & 0o200) === 0) {
        clearWindowsReadOnly(backupPath)
      }
    }
    renameFileWithWindowsRetry(tempPath, backupPath)
  } finally {
    rmSync(tempPath, { force: true })
  }
}

/** On Windows the owner write bit is the read-only attribute; ACLs are untouched. */
function clearWindowsReadOnly(filePath: string): void {
  chmodSync(filePath, 0o666)
}
