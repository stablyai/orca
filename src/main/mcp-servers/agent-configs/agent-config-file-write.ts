// Publishing an edited agent config without blocking the thread: only while the file still holds
// the bytes the edit was made from, after copying those bytes to a rolling `.bak` beside it.
import { randomUUID } from 'node:crypto'
import { chmod, copyFile, lstat, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { renameFileWithWindowsRetryAsync } from '../../../shared/file-write/windows-retry-file-operations'
import { isDefinitiveAbsence } from '../../../shared/errors/definitive-filesystem-absence'
import { isReplaceableReadOnlyBackup } from '../../filesystem/rolling-file-backup'

/** The file's text (BOM kept), or null when it is definitely absent. */
export async function readAgentConfigText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
}

/**
 * Replaces `path` (a dotfile symlink's target) with `contents`; false, writing nothing, when the
 * file no longer holds `computedFrom`, so the caller redoes its edit on the newer save.
 */
export async function writeAgentConfigIfUnchanged(
  path: string,
  contents: string,
  computedFrom: string
): Promise<boolean> {
  const link = await lstatIfPresent(path)
  const target = link?.isSymbolicLink() ? await realpath(path) : path
  const unchanged = async (): Promise<boolean> =>
    (await readAgentConfigText(target)) === computedFrom
  const mode = (await stat(target)).mode & 0o777
  const temp = `${target}.${randomUUID()}.tmp`
  const backup = `${target}.bak`
  const backupTemp = `${backup}.${randomUUID()}.tmp`
  try {
    // Agent configs can hold tokens: the new file keeps the old one's permissions.
    await writeFile(temp, contents, { mode, flag: 'wx' })
    if (process.platform !== 'win32') {
      await chmod(temp, mode)
    }
    const previousBackup = await lstatIfPresent(backup)
    if (previousBackup?.isSymbolicLink()) {
      // copyFile follows a destination link and could overwrite an unrelated file.
      throw new Error(`Refusing to overwrite symlinked backup: ${backup}`)
    }
    await copyFile(target, backupTemp)
    // A save that lands while the copy is made keeps the previous backup and refuses the edit.
    if (!(await unchanged())) {
      return false
    }
    if (process.platform === 'win32') {
      // copyFile keeps a read-only attribute, and Windows refuses to rename over a read-only file.
      await chmod(backupTemp, 0o666)
      if (isReplaceableReadOnlyBackup(previousBackup)) {
        await chmod(backup, 0o666)
      }
    }
    await renameFileWithWindowsRetryAsync(backupTemp, backup)
    if (!(await unchanged())) {
      return false
    }
    return await renameFileWithWindowsRetryAsync(temp, target)
  } finally {
    await Promise.all([rm(temp, { force: true }), rm(backupTemp, { force: true })])
  }
}
