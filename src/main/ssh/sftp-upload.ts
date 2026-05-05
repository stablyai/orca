import { createReadStream } from 'fs'
import { readdir } from 'fs/promises'
import { join as pathJoin } from 'path'
import type { SFTPWrapper } from 'ssh2'

export function mkdirSftp(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (err) => {
      // Why: SFTP status code 4 (SSH_FX_FAILURE) is a generic code that
      // OpenSSH returns for "already exists," but could also cover other
      // failures (e.g. permission denied on parent). We accept this ambiguity
      // because the next operation (write/recurse) will surface the real error.
      if (err && (err as { code?: number }).code !== 4) {
        reject(err)
      } else {
        resolve()
      }
    })
  })
}

export function uploadFile(
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const readStream = createReadStream(localPath)
    const writeStream = sftp.createWriteStream(remotePath)

    const settle = (fn: typeof resolve | typeof reject, val?: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      readStream.destroy()
      writeStream.destroy()
      fn(val as never)
    }

    writeStream.on('close', () => settle(resolve))
    writeStream.on('error', (err) => settle(reject, err))
    readStream.on('error', (err) => settle(reject, err))

    readStream.pipe(writeStream)
  })
}

export async function uploadDirectory(
  sftp: SFTPWrapper,
  localDir: string,
  remoteDir: string
): Promise<void> {
  const entries = await readdir(localDir, { withFileTypes: true })
  for (const entry of entries) {
    const localPath = pathJoin(localDir, entry.name)
    const remotePath = `${remoteDir}/${entry.name}`

    // Why: skip symlinks and special files (sockets, FIFOs, devices) to
    // prevent following symlinks that could exfiltrate local files to the
    // remote. The caller's pre-scan catches symlinks up-front, but this
    // guard closes the TOCTOU gap if one is created between scan and upload.
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
      continue
    }

    if (entry.isDirectory()) {
      await mkdirSftp(sftp, remotePath)
      await uploadDirectory(sftp, localPath, remotePath)
    } else {
      await uploadFile(sftp, localPath, remotePath)
    }
  }
}

/**
 * Check whether a path exists on the remote via SFTP lstat.
 * Returns true if the path exists (file, directory, or symlink).
 */
export function sftpPathExists(sftp: SFTPWrapper, remotePath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    sftp.lstat(remotePath, (err) => {
      if (!err) {
        resolve(true)
        return
      }
      // Why: SFTP status code 2 = SSH_FX_NO_SUCH_FILE — the path does not
      // exist, which is the expected "no collision" signal for deconfliction.
      if ((err as { code?: number }).code === 2) {
        resolve(false)
        return
      }
      reject(err)
    })
  })
}
