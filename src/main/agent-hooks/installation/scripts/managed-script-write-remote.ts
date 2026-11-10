import { randomUUID } from 'node:crypto'
import type { SFTPWrapper } from 'ssh2'
import {
  readFile,
  writeFile,
  rename,
  unlink,
  chmod,
  mkdirpRemote,
  dirnamePosix
} from '../remote/hook-sftp-operations'

/** POSIX SSH targets only: paths and script payloads follow POSIX conventions. */
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
    // Retry through the atomic write path after a failed read.
  }

  // Publish only a complete executable script; existing configs may invoke it during reinstall.
  const tmp = `${dir}/.${Date.now()}-${randomUUID()}.tmp`
  try {
    await writeFile(sftp, tmp, content, 0o755)
    await chmod(sftp, tmp, 0o755)
    await rename(sftp, tmp, remotePath)
  } finally {
    try {
      await unlink(sftp, tmp)
    } catch {
      // Cleanup is best effort.
    }
  }
}
