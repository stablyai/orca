import { constants } from 'node:fs'
import type { ReadStream } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join as pathJoin, relative, sep } from 'node:path'
import { finished } from 'node:stream/promises'
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
  options?: { exclusive?: boolean; signal?: AbortSignal }
): Promise<void> {
  return uploadFileAndJoinTeardown(sftp, localPath, remotePath, options)
}

async function uploadFileAndJoinTeardown(
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string,
  options?: { exclusive?: boolean; signal?: AbortSignal }
): Promise<void> {
  const handle = await open(localPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let handleClose: Promise<void> | undefined
  let readStream: ReadStream | undefined
  let writeStream: ReturnType<SFTPWrapper['createWriteStream']> | undefined
  const closeHandle = (): Promise<void> => {
    handleClose ??= handle.close()
    return handleClose
  }
  try {
    options?.signal?.throwIfAborted()
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
    // Why: rejected local sources must not leave an empty remote file.
    writeStream = sftp.createWriteStream(remotePath, {
      flags: options?.exclusive ? 'wx' : 'w'
    })
    readStream = handle.createReadStream({ autoClose: false })
    const abortTransfer = (): void => {
      const reason =
        options?.signal?.reason instanceof Error
          ? options.signal.reason
          : Object.assign(new Error('Upload aborted'), { name: 'AbortError' })
      readStream?.destroy(reason)
      writeStream?.destroy()
      void closeHandle().catch(() => {})
    }
    options?.signal?.addEventListener('abort', abortTransfer, { once: true })
    if (options?.signal?.aborted) {
      abortTransfer()
    }
    try {
      const readDone = finished(readStream, { cleanup: true }).catch((error: unknown) => {
        writeStream?.destroy()
        throw error
      })
      const writeDone = finished(writeStream, { cleanup: true }).catch((error: unknown) => {
        readStream?.destroy(error instanceof Error ? error : undefined)
        throw error
      })
      readStream.pipe(writeStream)
      const results = await Promise.allSettled([readDone, writeDone])
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') {
        throw failure.reason
      }
    } finally {
      options?.signal?.removeEventListener('abort', abortTransfer)
    }
  } finally {
    readStream?.destroy()
    writeStream?.destroy()
    await closeHandle()
  }
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

    const cleanupListeners = (): void => {
      writeStream.off('close', onClose)
      writeStream.off('error', onError)
    }
    const settle = (fn: typeof resolve | typeof reject, val?: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      cleanupListeners()
      writeStream.destroy()
      fn(val as never)
    }
    const onClose = (): void => settle(resolve)
    const onError = (err: Error): void => settle(reject, err)

    writeStream.on('close', onClose)
    writeStream.on('error', onError)
    writeStream.end(buffer)
  })
}

export function writeStringViaSftp(
  sftp: SFTPWrapper,
  remotePath: string,
  contents: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = sftp.createWriteStream(remotePath)
    let settled = false
    const cleanup = (): void => {
      sftp.removeListener('error', onError)
      ws.removeListener('close', onClose)
      ws.removeListener('error', onError)
    }
    const onClose = (): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve()
    }
    const onError = (err: Error): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(err)
    }
    // Why: prepend so a session error settles this write before a late-error swallower sees it.
    sftp.prependOnceListener('error', onError)
    ws.once('close', onClose)
    ws.once('error', onError)
    ws.end(contents)
  })
}

export async function uploadDirectory(
  sftp: SFTPWrapper,
  localDir: string,
  remoteDir: string,
  rootRealPath = localDir,
  options?: { exclusive?: boolean; signal?: AbortSignal }
): Promise<void> {
  options?.signal?.throwIfAborted()
  await assertLocalUploadPathInsideRoot(rootRealPath, localDir)
  const entries = await readdir(localDir, { withFileTypes: true })
  for (const entry of entries) {
    options?.signal?.throwIfAborted()
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
      await uploadFile(sftp, localPath, remotePath, options)
    }
  }
}

export async function removeDirectorySftp(sftp: SFTPWrapper, remoteDir: string): Promise<void> {
  const entries = await readdirSftp(sftp, remoteDir)
  const normalizedRemoteDir = remoteDir.replace(/\/+$/, '')
  for (const entry of entries) {
    if (entry.filename === '.' || entry.filename === '..') {
      continue
    }
    const childPath = `${normalizedRemoteDir}/${entry.filename}`
    await (entry.attrs?.isDirectory?.()
      ? removeDirectorySftp(sftp, childPath)
      : unlinkSftp(sftp, childPath))
  }
  await rmdirSftp(sftp, remoteDir)
}

type SftpDirectoryEntry = {
  filename: string
  attrs?: {
    isDirectory?: () => boolean
  }
}

function readdirSftp(sftp: SFTPWrapper, remoteDir: string): Promise<SftpDirectoryEntry[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(remoteDir, (err, entries) => {
      if (err) {
        reject(err)
        return
      }
      resolve((entries ?? []) as SftpDirectoryEntry[])
    })
  })
}

function unlinkSftp(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(remotePath, (err) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
}

function rmdirSftp(sftp: SFTPWrapper, remoteDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rmdir(remoteDir, (err) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
}

async function assertLocalUploadPathInsideRoot(
  rootRealPath: string,
  candidatePath: string
): Promise<void> {
  const candidateRealPath = await realpath(candidatePath)
  const relativeToRoot = relative(rootRealPath, candidateRealPath)
  if (
    relativeToRoot !== '' &&
    (relativeToRoot === '..' || relativeToRoot.startsWith(`..${sep}`) || isAbsolute(relativeToRoot))
  ) {
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
