import type { SFTPWrapper } from 'ssh2'

/**
 * Stream a remote file to a local path via SFTP fastGet.
 * Why: fastGet pipes in chunks with parallel reads, so downloads are not
 * bounded by the relay's single-frame read cap and never buffer the whole
 * file (or its base64 expansion) in memory.
 */
export function downloadFileViaSftp(
  sftp: SFTPWrapper,
  remotePath: string,
  localPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (err) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
}
