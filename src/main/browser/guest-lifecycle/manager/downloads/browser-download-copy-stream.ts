import type { FileHandle } from 'node:fs/promises'
import {
  BROWSER_DOWNLOAD_COPY_FRAME_BYTES,
  BROWSER_DOWNLOAD_COPY_FRAME_KIND,
  BROWSER_DOWNLOAD_COPY_WINDOW_BYTES,
  decodeBrowserDownloadCopyAck,
  type BrowserDownloadCopyStreamEvent
} from '../../../../../shared/browser/downloads/browser-download-copy-stream'
import type { RpcBinarySender } from '../../../../runtime/rpc/transports/rpc-binary-sender'
import { BrowserError } from '../../../browser-error'

// A desktop that stops acking (asleep, gone) frees the file.
const ACK_IDLE_MS = 60_000

export type BrowserDownloadCopyStreamTransport = {
  emit: (event: BrowserDownloadCopyStreamEvent) => void
  sendBinary: RpcBinarySender
  registerBinaryMessageHandler: (handler: (bytes: Uint8Array) => void) => () => void
  signal?: AbortSignal
}

/**
 * Sends the claimed file as binary frames, at most a window ahead of the desktop's acks, from a
 * fixed set of buffers: memory stays the window whatever the file's size.
 */
export async function streamBrowserDownloadCopy(
  file: { handle: FileHandle; size: number },
  transport: BrowserDownloadCopyStreamTransport
): Promise<void> {
  const { handle, size } = file
  const { emit, sendBinary, signal } = transport
  let acked = 0
  let failure: Error | null = null
  let wake: (() => void) | null = null
  const notify = (): void => {
    wake?.()
    wake = null
  }
  const unregister = transport.registerBinaryMessageHandler((bytes) => {
    const written = decodeBrowserDownloadCopyAck(bytes)
    if (written === null || written < acked || written > sent) {
      failure = new BrowserError('browser_error', 'The desktop sent an invalid acknowledgement.')
    } else {
      acked = written
    }
    notify()
  })
  const onAbort = (): void => notify()
  signal?.addEventListener('abort', onAbort)
  // Waits until `ready()`, a failure, an abort, or a minute with no ack.
  const waitFor = async (ready: () => boolean): Promise<void> => {
    while (!ready()) {
      signal?.throwIfAborted()
      if (failure) {
        throw failure
      }
      const before = acked
      await new Promise<void>((resolve) => {
        wake = resolve
        const timer = setTimeout(resolve, ACK_IDLE_MS)
        timer.unref()
        const clear = wake
        wake = () => {
          clearTimeout(timer)
          clear()
        }
      })
      if (acked === before && !ready() && !failure && !signal?.aborted) {
        throw new BrowserError('browser_error', 'The desktop stopped receiving the download.')
      }
    }
    signal?.throwIfAborted()
    if (failure) {
      throw failure
    }
  }

  const frameCount = BROWSER_DOWNLOAD_COPY_WINDOW_BYTES / BROWSER_DOWNLOAD_COPY_FRAME_BYTES
  const buffers = Array.from({ length: frameCount }, () => {
    const buffer = Buffer.allocUnsafe(1 + BROWSER_DOWNLOAD_COPY_FRAME_BYTES)
    buffer[0] = BROWSER_DOWNLOAD_COPY_FRAME_KIND
    return buffer
  })
  let sent = 0
  try {
    emit({ type: 'start', size })
    for (let index = 0; sent < size; index += 1) {
      // The buffer reused here was sent a window ago; its ack says it left this host.
      await waitFor(
        () => sent + BROWSER_DOWNLOAD_COPY_FRAME_BYTES - acked <= BROWSER_DOWNLOAD_COPY_WINDOW_BYTES
      )
      const buffer = buffers[index % frameCount]!
      const length = Math.min(BROWSER_DOWNLOAD_COPY_FRAME_BYTES, size - sent)
      const { bytesRead } = await handle.read(buffer, 1, length, sent)
      if (bytesRead !== length) {
        throw new BrowserError('browser_error', 'The download could not be read on the server.')
      }
      if (sendBinary(buffer.subarray(0, 1 + length)) === false) {
        throw new BrowserError('browser_error', 'The connection to the desktop closed.')
      }
      sent += length
    }
    await waitFor(() => acked === size)
    emit({ type: 'end' })
  } finally {
    signal?.removeEventListener('abort', onAbort)
    unregister()
  }
}
