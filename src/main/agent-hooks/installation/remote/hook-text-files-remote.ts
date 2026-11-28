import { randomUUID } from 'node:crypto'
import type { SFTPWrapper } from 'ssh2'
import {
  DEFAULT_REMOTE_CONFIG_MODE,
  readFile,
  writeFile,
  getRemoteFileModeOrDefault,
  rename,
  unlink,
  chmod,
  readdir,
  mkdirpRemote,
  dirnamePosix,
  isNoEntryError
} from './hook-sftp-operations'

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

/** Null means the directory is missing; propagate other I/O failures. */
export async function listRemoteDirectory(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<string[] | null> {
  try {
    return (await readdir(sftp, remotePath)).map((entry) => entry.filename)
  } catch (err) {
    if (isNoEntryError(err)) {
      return null
    }
    throw err
  }
}

/**
 * With `computedFrom` (the bytes the edit was made from, null for absent), returns false without
 * publishing when the file changed since, so the caller redoes its edit instead of clobbering a save.
 */
export async function writeTextFileRemoteAtomic(
  sftp: SFTPWrapper,
  remotePath: string,
  content: string,
  options?: { computedFrom: string | null }
): Promise<boolean> {
  const dir = dirnamePosix(remotePath)
  await mkdirpRemote(sftp, dir)
  try {
    const existing = await readFile(sftp, remotePath)
    if (existing === content) {
      return true
    }
  } catch {
    // Retry through the atomic write path after a failed read.
  }

  const tmp = `${dir}/.${Date.now()}-${randomUUID()}.tmp`
  try {
    const mode = await getRemoteFileModeOrDefault(sftp, remotePath, DEFAULT_REMOTE_CONFIG_MODE)
    await writeFile(sftp, tmp, content, mode)
    await chmod(sftp, tmp, mode)
    // Last check before the rename; only this round trip is left for a save to slip through.
    if (options && (await readTextFileRemote(sftp, remotePath)) !== options.computedFrom) {
      return false
    }
    await rename(sftp, tmp, remotePath)
    return true
  } finally {
    try {
      await unlink(sftp, tmp)
    } catch {
      // Cleanup is best effort.
    }
  }
}
