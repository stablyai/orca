import type { SFTPWrapper } from 'ssh2'

import type { HooksConfig } from './installer-utils'
import { readTextFileRemote, writeHooksJsonRemote } from './installer-utils-remote'
import { parseHooksJsonText } from './hooks-json-read'

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
  if ((await readTextFileRemote(sftp, remotePath)) !== expectedRaw) {
    return false
  }
  await writeHooksJsonRemote(sftp, remotePath, config)
  return true
}

export async function removeTextFileRemoteIfUnchanged(
  sftp: SFTPWrapper,
  remotePath: string,
  expectedRaw: string
): Promise<boolean> {
  if ((await readTextFileRemote(sftp, remotePath)) !== expectedRaw) {
    return false
  }
  await new Promise<void>((resolve, reject) => {
    sftp.unlink(remotePath, (error) => (error ? reject(error) : resolve()))
  })
  return true
}
