import { constants } from 'node:fs'
import type { ReadStream } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { finished } from 'node:stream/promises'
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

export async function uploadFile(
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string,
  options?: { exclusive?: boolean; signal?: AbortSignal }
): Promise<void> {
  await uploadFileWithWindow(sftp, localPath, remotePath, SFTP_UPLOAD_IN_FLIGHT_BYTES, options)
}

export async function uploadFileWithWindow(
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string,
  highWaterMark: number,
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
    options?.signal?.throwIfAborted()
    writeStream = sftp.createWriteStream(remotePath, {
      flags: options?.exclusive ? 'wx' : 'w',
      highWaterMark
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
