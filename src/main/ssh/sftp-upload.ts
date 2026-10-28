import { constants } from 'node:fs'
import type { ReadStream } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join as pathJoin, relative, sep } from 'node:path'
import { finished } from 'node:stream/promises'
import { promisify } from 'node:util'
import type { SFTPWrapper } from 'ssh2'
import { latchLateSftpStreamErrors, type SftpStreamErrorLatch } from './sftp-stream-late-error'
import { sftpSessionClosedError } from './ssh-file-transfer-abort'

// Buffer 2 MiB so ssh2 _writev pipelines requests instead of waiting one RTT per chunk, matching fastPut's 64 × 32 KiB window.
export const SFTP_UPLOAD_IN_FLIGHT_BYTES = 2 * 1024 * 1024

/** On dead links CLOSE may never reply; session close must settle transfer and close its local file handle. */
function watchSessionClose(sftp: SFTPWrapper): { closed: Promise<'closed'>; release: () => void } {
  let onClose: () => void = () => {}
  const closed = new Promise<'closed'>((resolve) => {
    onClose = () => resolve('closed')
  })
  sftp.once('close', onClose)
  return { closed, release: () => sftp.removeListener('close', onClose) }
}

function mkdirSftp(
  sftp: SFTPWrapper,
  path: string,
  options?: { allowExisting?: boolean }
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (err) => {
      // Status 4 can mean already-exists or another failure; allow it and let the next write/recurse expose the actual refusal.
      if (err && ((err as { code?: number }).code !== 4 || options?.allowExisting === false)) {
        reject(err)
      } else {
        resolve()
      }
    })
  })
}

export async function uploadFile(
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string,
  options?: { exclusive?: boolean; signal?: AbortSignal }
): Promise<void> {
  const handle = await open(localPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let handleClose: Promise<void> | undefined
  let readStream: ReadStream | undefined
  let writeStream: ReturnType<SFTPWrapper['createWriteStream']> | undefined
  let writeStreamErrors: SftpStreamErrorLatch | undefined
  const sessionClosed = watchSessionClose(sftp)
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
    // Validate local source before creating any remote file.
    writeStream = sftp.createWriteStream(remotePath, {
      flags: options?.exclusive ? 'wx' : 'w',
      highWaterMark: SFTP_UPLOAD_IN_FLIGHT_BYTES
    })
    // Late OPEN replies can throw from ssh2's parser; keep an error listener beyond settlement (#15479).
    writeStreamErrors = latchLateSftpStreamErrors(writeStream, remotePath)
    readStream = handle.createReadStream({ autoClose: false })
    // finished removes read listeners; retain an error sink for abort-after-EOF while finished owns transfer outcome.
    readStream.on('error', () => {})
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
      const results = await Promise.race([
        Promise.allSettled([readDone, writeDone]),
        sessionClosed.closed
      ])
      if (results === 'closed') {
        throw sftpSessionClosedError()
      }
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') {
        throw failure.reason
      }
    } finally {
      options?.signal?.removeEventListener('abort', abortTransfer)
    }
  } finally {
    sessionClosed.release()
    writeStreamErrors?.markTransferSettled()
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
    const lateErrors = latchLateSftpStreamErrors(writeStream, remotePath)

    const cleanupListeners = (): void => {
      lateErrors.markTransferSettled()
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
    const lateErrors = latchLateSftpStreamErrors(ws, remotePath)
    let settled = false
    const cleanup = (): void => {
      lateErrors.markTransferSettled()
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
    // Settle this write before the session's late-error swallower sees the error.
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
  root = localDir,
  options?: { exclusive?: boolean; signal?: AbortSignal }
): Promise<void> {
  options?.signal?.throwIfAborted()
  // Canonicalize root like entries; symlinks, junctions and Windows 8.3 paths otherwise look escaped.
  await uploadDirectoryWithinRoot(sftp, localDir, remoteDir, await realpath(root), options)
}

async function uploadDirectoryWithinRoot(
  sftp: SFTPWrapper,
  localDir: string,
  remoteDir: string,
  rootRealPath: string,
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

    // Reject symlinks/special files again after pre-scan to close replacement races that could upload unrelated local data.
    if (statResult.isSymbolicLink() || (!statResult.isFile() && !statResult.isDirectory())) {
      continue
    }

    if (statResult.isDirectory()) {
      await mkdirSftp(sftp, remotePath, { allowExisting: !options?.exclusive })
      await uploadDirectoryWithinRoot(sftp, localPath, remotePath, rootRealPath, options)
    } else {
      await uploadFile(sftp, localPath, remotePath, options)
    }
  }
}

export async function removeDirectorySftp(sftp: SFTPWrapper, remoteDir: string): Promise<void> {
  const entries = (await promisify(sftp.readdir.bind(sftp))(remoteDir)) ?? []
  const normalizedRemoteDir = remoteDir.replace(/\/+$/, '')
  for (const entry of entries) {
    if (entry.filename === '.' || entry.filename === '..') {
      continue
    }
    const childPath = `${normalizedRemoteDir}/${entry.filename}`
    await (entry.attrs?.isDirectory?.()
      ? removeDirectorySftp(sftp, childPath)
      : promisify(sftp.unlink.bind(sftp))(childPath))
  }
  await promisify(sftp.rmdir.bind(sftp))(remoteDir)
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
