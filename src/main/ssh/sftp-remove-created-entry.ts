import type { SFTPWrapper } from 'ssh2'

/** Non-recursive by construction: SFTP RMDIR fails on a directory that is not empty. */
export function removeCreatedSftpEntry(
  sftp: SFTPWrapper,
  remotePath: string,
  kind: 'file' | 'directory'
): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (error?: Error | null): void => (error ? reject(error) : resolve())
    if (kind === 'directory') {
      sftp.rmdir(remotePath, done)
    } else {
      sftp.unlink(remotePath, done)
    }
  })
}
