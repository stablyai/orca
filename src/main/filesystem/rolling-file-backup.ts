import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { lstatSync, rmSync } from 'node:fs'
import {
  copyFileWithWindowsRetry,
  renameFileWithWindowsRetry
} from '../../shared/file-write/windows-retry-file-operations'

const backupsSkipped = new AsyncLocalStorage<true>()

/** Removal writes run here so the `.bak` never captures the hooked copy being stripped. */
export function runWithoutRollingFileBackups<T>(run: () => T): T {
  return backupsSkipped.run(true, run)
}

export function areRollingFileBackupsEnabled(): boolean {
  return backupsSkipped.getStore() !== true
}

export function writeRollingFileBackup(sourcePath: string, backupPath: string): void {
  if (!areRollingFileBackupsEnabled()) {
    return
  }
  try {
    if (lstatSync(backupPath).isSymbolicLink()) {
      // copyFile follows destination symlinks and could corrupt an unrelated file.
      throw new Error(`Refusing to overwrite symlinked backup: ${backupPath}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  const tempPath = `${backupPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    // A fresh inode avoids hard-link mutation; rename preserves the old backup on failure.
    copyFileWithWindowsRetry(sourcePath, tempPath)
    renameFileWithWindowsRetry(tempPath, backupPath)
  } finally {
    rmSync(tempPath, { force: true })
  }
}
