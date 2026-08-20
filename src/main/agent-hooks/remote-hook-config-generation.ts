import type { SFTPWrapper } from 'ssh2'

import type { HooksConfig } from './installer-utils'
import {
  ensureRemoteDirectory,
  getRemoteFileModeOrDefaultForGuard,
  readTextFileRemote,
  renameRemoteFile,
  unlinkRemote,
  writeTextFileRemoteExclusive
} from './installer-utils-remote'
import { parseHooksJsonText } from './hooks-json-read'

const REMOTE_GUARDED_SUFFIX = '.orca-guarded'

export async function readHooksJsonRemoteWithRaw(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<{ config: HooksConfig | null; raw: string | null }> {
  const raw = await readTextFileRemote(sftp, remotePath)
  return {
    config: raw === null ? {} : parseHooksJsonText(raw),
    raw
  }
}

export async function writeHooksJsonRemoteIfUnchanged(
  sftp: SFTPWrapper,
  remotePath: string,
  expectedRaw: string | null,
  config: HooksConfig
): Promise<boolean> {
  const contents = `${JSON.stringify(config, null, 2)}\n`
  const heldPath = guardedPath(remotePath)
  await recoverInterruptedMutation(sftp, heldPath, remotePath)
  if (expectedRaw === null) {
    await ensureRemoteDirectory(sftp, dirnamePosix(remotePath))
    try {
      await writeTextFileRemoteExclusive(sftp, remotePath, contents)
      return true
    } catch (error) {
      if (await isExclusiveCreateConflict(sftp, remotePath, error)) {
        return false
      }
      throw error
    }
  }

  if (!(await moveTargetToHeld(sftp, remotePath, heldPath))) {
    return false
  }
  try {
    if ((await readTextFileRemote(sftp, heldPath)) !== expectedRaw) {
      await restoreHeldWithoutOverwrite(sftp, heldPath, remotePath)
      return false
    }
    const mode = await getRemoteFileModeOrDefaultForGuard(sftp, heldPath)
    try {
      await writeTextFileRemoteExclusive(sftp, remotePath, contents, mode)
    } catch (error) {
      if (await isExclusiveCreateConflict(sftp, remotePath, error)) {
        await unlinkRemote(sftp, heldPath)
        return false
      }
      throw error
    }
    await unlinkRemote(sftp, heldPath)
    return true
  } catch (error) {
    await restoreHeldWithoutOverwrite(sftp, heldPath, remotePath)
    throw error
  }
}

export async function removeTextFileRemoteIfUnchanged(
  sftp: SFTPWrapper,
  remotePath: string,
  expectedRaw: string
): Promise<boolean> {
  const heldPath = guardedPath(remotePath)
  await recoverInterruptedMutation(sftp, heldPath, remotePath)
  if (!(await moveTargetToHeld(sftp, remotePath, heldPath))) {
    return false
  }
  try {
    if ((await readTextFileRemote(sftp, heldPath)) !== expectedRaw) {
      await restoreHeldWithoutOverwrite(sftp, heldPath, remotePath)
      return false
    }
    await unlinkRemote(sftp, heldPath)
    return true
  } catch (error) {
    await restoreHeldWithoutOverwrite(sftp, heldPath, remotePath)
    throw error
  }
}

function guardedPath(remotePath: string): string {
  return `${remotePath}${REMOTE_GUARDED_SUFFIX}`
}

async function recoverInterruptedMutation(
  sftp: SFTPWrapper,
  heldPath: string,
  targetPath: string
): Promise<void> {
  await restoreHeldWithoutOverwrite(sftp, heldPath, targetPath)
}

async function restoreHeldWithoutOverwrite(
  sftp: SFTPWrapper,
  heldPath: string,
  targetPath: string
): Promise<void> {
  const heldContents = await readTextFileRemote(sftp, heldPath)
  if (heldContents === null) {
    return
  }
  const mode = await getRemoteFileModeOrDefaultForGuard(sftp, heldPath)
  try {
    await writeTextFileRemoteExclusive(sftp, targetPath, heldContents, mode)
  } catch (error) {
    if (!(await isExclusiveCreateConflict(sftp, targetPath, error))) {
      throw error
    }
  }
  await unlinkRemote(sftp, heldPath)
}

async function moveTargetToHeld(
  sftp: SFTPWrapper,
  targetPath: string,
  heldPath: string
): Promise<boolean> {
  try {
    await renameRemoteFile(sftp, targetPath, heldPath)
    return true
  } catch (error) {
    if (isNoEntryError(error)) {
      return false
    }
    throw error
  }
}

function isNoEntryError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 2)
}

function isFileAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const code = (error as { code?: unknown }).code
  const message = (error as { message?: unknown }).message
  // Why: OpenSSH SFTP v3 reports O_EXCL collisions as generic SSH_FX_FAILURE.
  return (
    code === 4 ||
    code === 11 ||
    (typeof message === 'string' && /already exists|file exists/i.test(message))
  )
}

async function isExclusiveCreateConflict(
  sftp: SFTPWrapper,
  remotePath: string,
  error: unknown
): Promise<boolean> {
  return isFileAlreadyExistsError(error) && (await readTextFileRemote(sftp, remotePath)) !== null
}

function dirnamePosix(remotePath: string): string {
  const index = remotePath.lastIndexOf('/')
  return index <= 0 ? (index === 0 ? '/' : '.') : remotePath.slice(0, index)
}
