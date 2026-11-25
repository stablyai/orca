// Publishing an edited agent config (or deleting one) without blocking the thread: only while the
// file still holds the bytes the edit was made from, after copying those bytes to a rolling `.bak`.
// The agent or an editor can save at any moment, so the file is taken aside before its last check and
// the edit goes in only where no newer save took the name: a save that lands meanwhile is kept.
// (atomic-file-publication's guarded write is synchronous and repairs folder ACLs, which suits
// Orca's own folders, not the user's home.)
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
import { dirname, resolve } from 'node:path'
import { renameFileWithWindowsRetryAsync } from '../../../shared/file-write/windows-retry-file-operations'
import { isDefinitiveAbsence } from '../../../shared/errors/definitive-filesystem-absence'
import { errnoCodeOrUnknown } from '../../../shared/errors/errno-code'
import { runKeyedSerializedOperation } from '../../../shared/concurrency/keyed-serialized-operations'
import { isHardLinkUnsupported } from '../../filesystem/hard-link-unsupported-error'
import { isReplaceableReadOnlyBackup } from '../../filesystem/rolling-file-backup'

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

const MAX_LINK_HOPS = 8

/** The file `path` names after its dotfile symlinks, even while that file is held aside. */
async function publishedPath(path: string): Promise<string> {
  let current = path
  for (let hop = 0; ; hop++) {
    if (!(await lstatIfPresent(current))?.isSymbolicLink()) {
      return current
    }
    if (hop === MAX_LINK_HOPS) {
      throw Object.assign(new Error(`Too many symbolic links: ${path}`), { code: 'ELOOP' })
    }
    // A relative link is read from its folder's real place, which may itself be a link.
    current = resolve(await realpath(dirname(current)), await readlink(current))
  }
}

/** Where a config waits while its edit is published; only Orca writes this name. */
const heldPathOf = (target: string): string => `${target}.orca-publishing`

/** Moves `source` over the rolling `.bak`, never through a symlinked one. */
async function replaceBackup(source: string, backup: string): Promise<void> {
  const previous = await lstatIfPresent(backup)
  if (previous?.isSymbolicLink()) {
    throw new Error(`Refusing to overwrite symlinked backup: ${backup}`)
  }
  if (process.platform === 'win32') {
    // copyFile keeps a read-only attribute, and Windows refuses to rename over a read-only file.
    await chmod(source, 0o666)
    if (isReplaceableReadOnlyBackup(previous)) {
      await chmod(backup, 0o666)
    }
  }
  await renameFileWithWindowsRetryAsync(source, backup)
}

/**
 * Refuses a drive with no hard links (FAT/exFAT, \\wsl$): nothing there publishes without
 * possibly replacing a newer save, so the config is never taken aside on it.
 */
async function assertHardLinks(target: string): Promise<void> {
  const probe = `${target}.${randomUUID()}.link-probe`
  try {
    await link(target, probe)
  } catch (error) {
    if (isHardLinkUnsupported(error)) {
      throw Object.assign(new Error(`Orca can't edit ${target} safely on this drive`), {
        code: errnoCodeOrUnknown(error)
      })
    }
    throw error
  } finally {
    await rm(probe, { force: true }).catch(() => {})
  }
}

// One read or publish of a config at a time in this process, so none sees it while it's held.
const configQueues = new Map<string, Promise<void>>()
const oneAtATime = <T>(target: string, run: () => Promise<T>): Promise<T> =>
  runKeyedSerializedOperation(configQueues, target, run)

/** The file's text (BOM kept), or null when it is definitely absent. */
export async function readAgentConfigText(path: string): Promise<string | null> {
  const target = await publishedPath(path)
  return oneAtATime(target, async () => {
    // Orca quit while publishing an edit: the config goes back before anyone reads it.
    if (await lstatIfPresent(heldPathOf(target))) {
      await restoreHeldAgentConfig(heldPathOf(target), target)
    }
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (isDefinitiveAbsence(error)) {
        return null
      }
      throw error
    }
  })
}

/**
 * Runs `publish` with the config at `target` held aside, once its bytes are still `computedFrom`;
 * false when they aren't (put back) or when a newer file took the name meanwhile (it stays).
 */
function withConfigHeld(
  target: string,
  computedFrom: string,
  publish: () => Promise<boolean>
): Promise<boolean> {
  const held = heldPathOf(target)
  return oneAtATime(target, async () => {
    try {
      await assertHardLinks(target)
      await renameFileWithWindowsRetryAsync(target, held)
    } catch (error) {
      if (isDefinitiveAbsence(error)) {
        return false
      }
      throw error
    }
    let published = false
    try {
      if ((await readFile(held)).equals(Buffer.from(computedFrom))) {
        published = await publish()
      }
      return published
    } finally {
      // Published (or deleted on purpose): the held bytes are the `.bak` already. Else they go back.
      await (published
        ? rm(held, { force: true }).catch(() => {})
        : restoreHeldAgentConfig(held, target))
    }
  })
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
  const target = await publishedPath(path)
  const mode = (await stat(target)).mode & 0o777
  const temp = `${target}.${randomUUID()}.tmp`
  const backupTemp = `${target}.bak.${randomUUID()}.tmp`
  try {
    // Agent configs can hold tokens: the new file keeps the old one's permissions.
    await writeFile(temp, contents, { mode, flag: 'wx' })
    if (process.platform !== 'win32') {
      await chmod(temp, mode)
    }
    await copyFile(target, backupTemp)
    // A save that lands while the copy is made keeps the previous backup and refuses the edit.
    if ((await readAgentConfigText(target)) !== computedFrom) {
      return false
    }
    await replaceBackup(backupTemp, `${target}.bak`)
    return await withConfigHeld(target, computedFrom, () => linkWithoutReplacing(temp, target))
  } finally {
    // Best effort: a Windows scanner holding the published file's second name must not fail it.
    await Promise.all([temp, backupTemp].map((file) => rm(file, { force: true }).catch(() => {})))
  }
}

export type AgentConfigRemoval = {
  /** Where this Orca holds the file while comparing it; two Orcas never share one. */
  held: string
  /** The emptied text, which needs no write; on a drive without hard links (where a held file
   *  can't go back safely) any other text is refused like every edit there. */
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
