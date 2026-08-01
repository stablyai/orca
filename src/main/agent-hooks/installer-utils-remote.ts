// Why: SFTP-backed equivalents of `installer-utils.ts` for the remote-install
// flow. Each function takes an `sftp` handle plus paths the agent CLI expects
// on the remote (e.g. `~/.claude/settings.json`). Lives in `agent-hooks/`
// because it shares the contract with the local installer (script body,
// hook-event shape, atomic-rename semantics) and any drift between them is
// exactly the bug we want to avoid.
//
// We deliberately keep the JSON merge logic in the existing
// `installer-utils.ts` and only swap fs primitives — the JSON shape and
// managed-command matching must stay identical to the local install.
//
// See docs/design/agent-status-over-ssh.md §8 (commit #8).

import { randomUUID } from 'node:crypto'
import type { SFTPWrapper } from 'ssh2'

import { isPlainObject, type HooksConfig } from './installer-utils'
import {
  chmod,
  dirnamePosix,
  getRemoteFileModeOrDefault,
  hardlinkNoReplace,
  isNoEntryError,
  mkdirpRemote,
  readFile,
  rename,
  statMode,
  unlink,
  writeFile
} from './sftp-file-primitives'

const DEFAULT_REMOTE_CONFIG_MODE = 0o600

/** Read+JSON-parse a remote file. Returns `null` on parse failure (caller
 *  surfaces "could not parse" status to the UI), `{}` on missing file
 *  (matches local behavior — first-install case). Rethrows on other I/O
 *  failures (permission denied, EIO, channel closed) so the caller can
 *  distinguish transient SFTP errors from a malformed-JSON case rather
 *  than collapsing both into a misleading "could not parse" diagnostic. */
export async function readHooksJsonRemote(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<HooksConfig | null> {
  return (await readHooksJsonRemoteWithRaw(sftp, remotePath)).config
}

async function readHooksJsonRemoteWithRaw(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<{ raw: string | null; config: HooksConfig | null }> {
  let raw: string
  try {
    raw = await readFile(sftp, remotePath)
  } catch (err) {
    if (isNoEntryError(err)) {
      return { raw: null, config: {} }
    }
    throw err
  }
  try {
    const parsed = JSON.parse(raw)
    return { raw, config: isPlainObject(parsed) ? parsed : null }
  } catch {
    return { raw, config: null }
  }
}

export async function updateHooksJsonRemoteWithRetry(
  sftp: SFTPWrapper,
  remotePath: string,
  mutate: (config: HooksConfig) => HooksConfig | null,
  maxAttempts = 3
): Promise<HooksConfig | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { raw: baseline, config } = await readHooksJsonRemoteWithRaw(sftp, remotePath)
    if (!config) {
      return null
    }
    const next = mutate(config)
    if (next === null) {
      return config
    }
    if (
      await writeHooksJsonRemote(sftp, remotePath, next, {
        expectedDiskContent: baseline
      })
    ) {
      return next
    }
  }
  return null
}

/** Suffix of the one-shot pristine backup taken before Orca's FIRST
 *  modification of a remote settings file. Never rotated by later writes, so
 *  the pre-Orca original stays recoverable (the local `.bak` rolls forward
 *  on every write; SFTP paths have more partial-failure modes, so the remote
 *  keeps the original instead). */
export const REMOTE_HOOKS_BACKUP_SUFFIX = '.orca-backup'

/** Atomically write a JSON config to the remote — write to a tmp path then
 *  rename, mirroring the local writeHooksJson contract. Before the first
 *  modification of an existing file a one-shot backup is written next to it
 *  (see REMOTE_HOOKS_BACKUP_SUFFIX). */
export async function writeHooksJsonRemote(
  sftp: SFTPWrapper,
  remotePath: string,
  config: HooksConfig,
  options: { expectedDiskContent?: string | null } = {}
): Promise<boolean> {
  const dir = dirnamePosix(remotePath)
  await mkdirpRemote(sftp, dir)
  const serialized = `${JSON.stringify(config, null, 2)}\n`
  // Why: skip the write when on-disk content is identical so repeated
  // install() calls do not bump the file's mtime / inode unnecessarily.
  let existingContent: string | null = null
  try {
    existingContent = await readFile(sftp, remotePath)
  } catch (error) {
    // Why: only a proven missing file may skip the pristine backup. Treating
    // EACCES, timeout, or channel failure as absence could overwrite an
    // existing settings file without its one-shot recovery copy.
    if (!isNoEntryError(error)) {
      throw error
    }
  }
  if (existingContent === serialized) {
    return true
  }
  if (
    options.expectedDiskContent !== undefined &&
    existingContent !== options.expectedDiskContent
  ) {
    return false
  }
  // Why: tmp + rename so a partial network drop mid-write does not leave a
  // truncated settings.json that the agent CLI would refuse to load.
  const tmp = `${dir}/.${Date.now()}-${randomUUID()}.tmp`
  try {
    const mode = await getRemoteFileModeOrDefault(sftp, remotePath, DEFAULT_REMOTE_CONFIG_MODE)
    await writeFile(sftp, tmp, serialized, mode)
    await chmod(sftp, tmp, mode)
    if (options.expectedDiskContent !== undefined) {
      const currentContent = await readRemoteRawFile(sftp, remotePath)
      if (currentContent !== options.expectedDiskContent) {
        return false
      }
    }
    if (existingContent !== null) {
      await writeOneShotBackup(sftp, remotePath, existingContent)
    }
    if (options.expectedDiskContent !== undefined) {
      const currentContent = await readRemoteRawFile(sftp, remotePath)
      if (currentContent !== options.expectedDiskContent) {
        return false
      }
    }
    await rename(sftp, tmp, remotePath)
  } finally {
    // Best-effort cleanup if rename failed.
    try {
      await unlink(sftp, tmp)
    } catch {
      // already gone or never created
    }
  }
  return true
}

async function readRemoteRawFile(sftp: SFTPWrapper, remotePath: string): Promise<string | null> {
  try {
    return await readFile(sftp, remotePath)
  } catch (error) {
    if (isNoEntryError(error)) {
      return null
    }
    throw error
  }
}

/** Write the managed hook script to the remote and chmod 0o755. POSIX-only —
 *  the relay deliberately does not support Windows-remote in v1 (see design
 *  doc §3 + §6). */
export async function writeManagedScriptRemote(
  sftp: SFTPWrapper,
  remotePath: string,
  content: string
): Promise<void> {
  const dir = dirnamePosix(remotePath)
  await mkdirpRemote(sftp, dir)
  try {
    const existing = await readFile(sftp, remotePath)
    if (existing === content) {
      await chmod(sftp, remotePath, 0o755)
      return
    }
  } catch {
    // ENOENT or read error — fall through to the atomic write below.
  }

  // Why: existing configs may already invoke this script. Write/chmod a temp
  // file first, then rename it into place so interrupted reinstalls do not
  // leave the configured hook path truncated or non-executable.
  const tmp = `${dir}/.${Date.now()}-${randomUUID()}.tmp`
  try {
    await writeFile(sftp, tmp, content, 0o755)
    await chmod(sftp, tmp, 0o755)
    await rename(sftp, tmp, remotePath)
  } finally {
    try {
      await unlink(sftp, tmp)
    } catch {
      // already gone or never created
    }
  }
}

export async function readTextFileRemote(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<string | null> {
  try {
    return await readFile(sftp, remotePath)
  } catch (err) {
    if (isNoEntryError(err)) {
      return null
    }
    throw err
  }
}

export async function writeTextFileRemoteAtomic(
  sftp: SFTPWrapper,
  remotePath: string,
  content: string
): Promise<void> {
  const dir = dirnamePosix(remotePath)
  await mkdirpRemote(sftp, dir)
  try {
    const existing = await readFile(sftp, remotePath)
    if (existing === content) {
      return
    }
  } catch {
    // ENOENT or read error — fall through to the atomic write below.
  }

  const tmp = `${dir}/.${Date.now()}-${randomUUID()}.tmp`
  try {
    const mode = await getRemoteFileModeOrDefault(sftp, remotePath, DEFAULT_REMOTE_CONFIG_MODE)
    await writeFile(sftp, tmp, content, mode)
    await chmod(sftp, tmp, mode)
    await rename(sftp, tmp, remotePath)
  } finally {
    try {
      await unlink(sftp, tmp)
    } catch {
      // already gone or never created
    }
  }
}

/** Write `<remotePath>.orca-backup` once, before Orca first modifies the
 *  file. An existing backup is never overwritten — it is the user's pre-Orca
 *  original. Failure propagates: silently proceeding without the backup would
 *  defeat its purpose, and the caller already surfaces a structured error. */
async function writeOneShotBackup(
  sftp: SFTPWrapper,
  remotePath: string,
  content: string
): Promise<void> {
  const backupPath = `${remotePath}${REMOTE_HOOKS_BACKUP_SUFFIX}`
  if (await remoteFileExists(sftp, backupPath)) {
    return
  }
  const tmp = `${backupPath}.${Date.now()}-${randomUUID()}.tmp`
  try {
    const mode = await getRemoteFileModeOrDefault(sftp, remotePath, DEFAULT_REMOTE_CONFIG_MODE)
    await writeFile(sftp, tmp, content, mode)
    await chmod(sftp, tmp, mode)
    await hardlinkNoReplace(sftp, tmp, backupPath)
  } finally {
    try {
      await unlink(sftp, tmp)
    } catch {
      // already gone or never created
    }
  }
}

async function remoteFileExists(sftp: SFTPWrapper, remotePath: string): Promise<boolean> {
  try {
    await statMode(sftp, remotePath)
    return true
  } catch (error) {
    if (isNoEntryError(error)) {
      return false
    }
    throw error
  }
}
