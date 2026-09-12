import { randomUUID } from 'node:crypto'
import { lstatSync, rmSync } from 'node:fs'
import { copyFileWithWindowsRetry, renameFileWithWindowsRetry } from './codex-accounts/fs-utils'

export function writeRollingFileBackup(sourcePath: string, backupPath: string): void {
  try {
    if (lstatSync(backupPath).isSymbolicLink()) {
      // Why: copyFile follows a destination symlink and can corrupt an
      // unrelated dotfiles target before the primary atomic write begins.
      throw new Error(`Refusing to overwrite symlinked backup: ${backupPath}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  const tempPath = `${backupPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    // Why: replacing the backup from a fresh inode cannot mutate another file
    // through a hard link, and a failed rename leaves the prior backup intact.
    copyFileWithWindowsRetry(sourcePath, tempPath)
    renameFileWithWindowsRetry(tempPath, backupPath)
  } finally {
    rmSync(tempPath, { force: true })
  }
}
