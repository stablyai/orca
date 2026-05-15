import { constants } from 'fs'
import type { ReadStream } from 'fs'
import { lstat, open, readdir, realpath } from 'fs/promises'
import { isAbsolute, join as pathJoin, relative } from 'path'
import type { SFTPWrapper } from 'ssh2'

export function mkdirSftp(
  sftp: SFTPWrapper,
  path: string,
  options?: { allowExisting?: boolean }
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (err) => {
      // Why: SFTP status code 4 (SSH_FX_FAILURE) is a generic code that
      // OpenSSH returns for "already exists," but could also cover other
      // failures (e.g. permission denied on parent). We accept this ambiguity
      // because the next operation (write/recurse) will surface the real error.
      if (err && ((err as { code?: number }).code !== 4 || options?.allowExisting === false)) {
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
  remotePath: string,
  options?: { exclusive?: boolean }
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let readStream: ReadStream | null = null
    let fileHandle: Awaited<ReturnType<typeof open>> | null = null
    let writeStream: ReturnType<SFTPWrapper['createWriteStream']> | null = null

    const settle = (fn: typeof resolve | typeof reject, val?: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      readStream?.destroy()
      writeStream?.destroy()
      void fileHandle?.close().catch(() => {})
      fn(val as never)
    }

    void open(localPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      .then(async (handle) => {
        if (settled) {
          void handle.close().catch(() => {})
          return
        }
        fileHandle = handle
        const statResult = await lstat(localPath)
        if (statResult.isSymbolicLink() || !statResult.isFile()) {
          throw new Error(`Unsupported upload source: ${localPath}`)
        }
        const openedStat = await handle.stat()
        if (
          !openedStat.isFile() ||
          openedStat.size !== statResult.size ||
          (statResult.ino !== 0 && openedStat.ino !== 0 && openedStat.ino !== statResult.ino) ||
          (statResult.dev !== 0 && openedStat.dev !== 0 && openedStat.dev !== statResult.dev)
        ) {
          throw new Error(`File changed during upload: ${localPath}`)
        }
        // Why: validate the local source before creating the remote write
        // target, so rejected sources do not leave empty files behind.
        writeStream = sftp.createWriteStream(remotePath, {
          flags: options?.exclusive ? 'wx' : 'w'
        })
        writeStream.on('close', () => settle(resolve))
        writeStream.on('error', (err) => settle(reject, err))
        readStream = handle.createReadStream()
        readStream.on('error', (err) => settle(reject, err))
        readStream.pipe(writeStream)
      })
      .catch((err: unknown) => settle(reject, err))
  })
}

export function uploadBuffer(
  sftp: SFTPWrapper,
  buffer: Buffer,
  remotePath: string,
  options?: { append?: boolean; exclusive?: boolean }
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const writeStream = sftp.createWriteStream(remotePath, {
      flags: options?.append ? 'a' : options?.exclusive ? 'wx' : 'w'
    })

    const settle = (fn: typeof resolve | typeof reject, val?: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      writeStream.destroy()
      fn(val as never)
    }

    writeStream.on('close', () => settle(resolve))
    writeStream.on('error', (err) => settle(reject, err))
    writeStream.end(buffer)
  })
}

export async function uploadDirectory(
  sftp: SFTPWrapper,
  localDir: string,
  remoteDir: string,
  rootRealPath = localDir,
  options?: { exclusive?: boolean }
): Promise<void> {
  await assertLocalUploadPathInsideRoot(rootRealPath, localDir)
  const entries = await readdir(localDir, { withFileTypes: true })
  for (const entry of entries) {
    const localPath = pathJoin(localDir, entry.name)
    const remotePath = `${remoteDir}/${entry.name}`
    await assertLocalUploadPathInsideRoot(rootRealPath, localPath)
    const statResult = await lstat(localPath)

    // Why: skip symlinks and special files (sockets, FIFOs, devices) to
    // prevent following symlinks that could exfiltrate local files to the
    // remote. The caller's pre-scan catches symlinks up-front, but this
    // guard closes the TOCTOU gap if one is created between scan and upload.
    if (statResult.isSymbolicLink() || (!statResult.isFile() && !statResult.isDirectory())) {
      continue
    }

    if (statResult.isDirectory()) {
      await mkdirSftp(sftp, remotePath, { allowExisting: !options?.exclusive })
      await uploadDirectory(sftp, localPath, remotePath, rootRealPath, options)
    } else {
      await uploadFile(sftp, localPath, remotePath, { exclusive: options?.exclusive })
    }
  }
}

async function assertLocalUploadPathInsideRoot(
  rootRealPath: string,
  candidatePath: string
): Promise<void> {
  const candidateRealPath = await realpath(candidatePath)
  const relativeToRoot = relative(rootRealPath, candidateRealPath)
  if (relativeToRoot !== '' && (relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot))) {
    throw new Error(`Path escaped upload root: ${candidatePath}`)
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
