// Publishing an edited agent config (or deleting one) without blocking the thread: only while the
// file still holds the bytes the edit was made from, after copying those bytes to a rolling `.bak`.
import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  copyFile,
  link,
  lstat,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { renameFileWithWindowsRetryAsync } from '../../../shared/file-write/windows-retry-file-operations'
import { isDefinitiveAbsence } from '../../../shared/errors/definitive-filesystem-absence'
import { getGuardedOperationHeldPath } from '../../filesystem/atomic-file-publication'
import { errnoCodeOrUnknown } from '../../../shared/errors/errno-code'
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

/**
 * Deletes `path` only while it holds `computedFrom`; false otherwise, or when a file is saved there
 * meanwhile. The async form of `removeFileAtomicallyIfUnchanged`, sharing its held name: the file is
 * moved to it before the compare, so a save landing at any moment is either the one compared (and put
 * back without replacing anything) or a new file at `path` that is never touched.
 */
export async function removeAgentConfigIfUnchanged(
  path: string,
  computedFrom: string
): Promise<boolean> {
  const held = getGuardedOperationHeldPath(path)
  // A removal that stopped between its move and its put-back left the file held.
  await restoreHeldConfig(held, path)
  const probe = `${path}.${randomUUID()}.link-probe`
  try {
    // Without hard links a held file can't go back without risking a newer save: leave it.
    await link(path, probe)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return false
    }
    throw error
  } finally {
    await rm(probe, { force: true })
  }
  try {
    await renameFileWithWindowsRetryAsync(path, held)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return false
    }
    throw error
  }
  let matched = false
  try {
    matched = (await readAgentConfigText(held)) === computedFrom
    if (matched) {
      // A failure here leaves it held for the next call to put back.
      await rm(held, { force: true })
    }
  } finally {
    if (!matched) {
      await restoreHeldConfig(held, path)
    }
  }
  return matched && (await lstatIfPresent(path)) === null
}

/**
 * Puts a held file back at `path`, never over a newer save there; that one stays and the held bytes
 * are kept beside it as `<path>.orca-kept-<content hash>`, as the guarded sync helpers keep theirs.
 * Throws, leaving it held for the next call, when neither name is free.
 */
async function restoreHeldConfig(held: string, path: string): Promise<void> {
  let bytes: Buffer
  try {
    bytes = await readFile(held)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return
    }
    throw error
  }
  const kept = `${path}.orca-kept-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`
  for (const target of [path, kept]) {
    const there = await readFile(target).catch(() => null)
    if (there?.equals(bytes) || (there === null && (await linkWithoutReplacing(held, target)))) {
      await rm(held, { force: true })
      if (target === kept) {
        console.warn('[agent-config] Kept an earlier version beside', path, kept)
      }
      return
    }
  }
  throw new Error(`Could not put back an earlier version of ${path}`)
}

/** False when `to` exists. A symlink stays one: macOS's link() would follow it. */
async function linkWithoutReplacing(from: string, to: string): Promise<boolean> {
  try {
    await ((await lstat(from)).isSymbolicLink()
      ? symlink(await readlink(from), to)
      : link(from, to))
    return true
  } catch (error) {
    if (errnoCodeOrUnknown(error) === 'EEXIST') {
      return false
    }
    throw error
  }
}
