import { randomUUID } from 'node:crypto'
import type { SFTPWrapper } from 'ssh2'
import type { HooksConfig } from './hook-config-schema'
import { parseHooksJsonText } from './hooks-json-read'
import {
  DEFAULT_REMOTE_CONFIG_MODE,
  readFile,
  writeFile,
  getRemoteFileModeOrDefault,
  rename,
  unlink,
  chmod,
  mkdirpRemote,
  dirnamePosix,
  isNoEntryError
} from '../remote/hook-sftp-operations'

/** Null means invalid JSON, {} means missing; propagate other I/O failures. */
export async function readHooksJsonRemote(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<HooksConfig | null> {
  let body: string
  try {
    body = await readFile(sftp, remotePath)
  } catch (err) {
    if (isNoEntryError(err)) {
      return {}
    }
    throw err
  }
  return parseHooksJsonText(body)
}

/** Atomically replace the remote config without rotating local-style backups. */
export async function writeHooksJsonRemote(
  sftp: SFTPWrapper,
  remotePath: string,
  config: Record<string, unknown>,
  // JSONC callers can supply text edited in place.
  options?: { serialized?: string }
): Promise<void> {
  const dir = dirnamePosix(remotePath)
  await mkdirpRemote(sftp, dir)
  const serialized = options?.serialized ?? `${JSON.stringify(config, null, 2)}\n`
  // Preserve mtime and inode on repeated installs.
  try {
    const existing = await readFile(sftp, remotePath)
    if (existing === serialized) {
      return
    }
  } catch {
    // Retry through the write path after a failed read.
  }
  // Atomic replacement prevents interrupted writes from truncating live settings.
  const tmp = `${dir}/.${Date.now()}-${randomUUID()}.tmp`
  try {
    const mode = await getRemoteFileModeOrDefault(sftp, remotePath, DEFAULT_REMOTE_CONFIG_MODE)
    await writeFile(sftp, tmp, serialized, mode)
    await chmod(sftp, tmp, mode)
    await rename(sftp, tmp, remotePath)
  } finally {
    try {
      await unlink(sftp, tmp)
    } catch {
      // Cleanup is best effort.
    }
  }
}
