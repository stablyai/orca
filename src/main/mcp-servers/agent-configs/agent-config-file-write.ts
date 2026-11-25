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
import { isHardLinkUnsupported } from '../../filesystem/hard-link-unsupported-error'
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

export type AgentConfigRemoval = {
  /** Where this Orca holds the file while comparing it; two Orcas never share one. */
  held: string
  /** Written instead on a filesystem without hard links, where a held file can't go back safely. */
  emptyText: string
}

/**
 * Deletes `path` only while it holds `computedFrom`; false otherwise, or when a file is saved there
 * meanwhile. The async form of `removeFileAtomicallyIfUnchanged`: the file is moved to `held` before
 * the compare, so a save landing at any moment is either the one compared (and put back without
 * replacing anything) or a new file at `path` that is never touched.
 */
export async function removeAgentConfigIfUnchanged(
  path: string,
  computedFrom: string,
  { held, emptyText }: AgentConfigRemoval
): Promise<boolean> {
  await restoreHeldAgentConfig(held, path)
  const probe = `${path}.${randomUUID()}.link-probe`
  try {
    await link(path, probe)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return false
    }
    if (!isHardLinkUnsupported(error)) {
      throw error
    }
    return (
      computedFrom === emptyText ||
      (await writeAgentConfigIfUnchanged(path, emptyText, computedFrom))
    )
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
      // A failure here leaves it held for the next restore.
      await rm(held, { force: true })
    }
  } finally {
    if (!matched) {
      await restoreHeldAgentConfig(held, path)
    }
  }
  return matched && (await lstatIfPresent(path)) === null
}

/**
 * Puts a file a stopped removal left held back at `path`, never over a newer save there; that one
 * stays and the held bytes are kept beside it as `<path>.orca-kept-<content hash>`, as the guarded
 * sync helpers keep theirs. Throws, leaving it held for the next try, when neither name is free.
 */
export async function restoreHeldAgentConfig(held: string, path: string): Promise<void> {
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
