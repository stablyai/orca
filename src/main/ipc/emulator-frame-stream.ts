import { BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { MjpegFrameStream } from '../emulator/mjpeg-frame-stream'
import { abortWhenRendererGone } from './renderer-lifetime-abort'

type FrameStreamSession = {
  stream: MjpegFrameStream
  disposeLifetime: () => void
}

const sessions = new Map<string, FrameStreamSession>()

function stopFrameStream(streamId: string): void {
  const session = sessions.get(streamId)
  if (!session) {
    return
  }
  sessions.delete(streamId)
  session.disposeLifetime()
  session.stream.stop()
}

function frameToArrayBuffer(frame: Buffer<ArrayBufferLike>): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(frame.byteLength)
  new Uint8Array(arrayBuffer).set(frame)
  return arrayBuffer
}

export function registerEmulatorFrameStreamHandlers(): void {
  ipcMain.handle(
    'emulator:frameStreamStart',
    (event, args: { streamUrl: string; streamKey?: string }): { streamId: string } => {
      const owner = event.sender
      const ownerWindow = BrowserWindow.fromWebContents(owner)
      if (!ownerWindow) {
        throw new Error('Emulator frame stream must originate from a BrowserWindow.')
      }

      const streamId = randomUUID()
      // Why: Chromium's NetworkService can restart under long-lived MJPEG loads;
      // the main process owns the socket so the renderer only receives JPEG bytes.
      const stream = new MjpegFrameStream(
        args.streamUrl,
        {
          onError: (message) => {
            if (sessions.has(streamId) && !owner.isDestroyed()) {
              owner.send('emulator:frameStreamError', { streamId, message })
            }
          },
          onFrame: (frame) => {
            if (sessions.has(streamId) && !owner.isDestroyed()) {
              owner.send('emulator:frameStreamFrame', {
                streamId,
                bytes: frameToArrayBuffer(frame)
              })
            }
          }
        },
        args.streamKey
      )

      const lifetime = abortWhenRendererGone(owner)
      const onRendererGone = (): void => stopFrameStream(streamId)
      sessions.set(streamId, {
        stream,
        disposeLifetime: () => {
          lifetime.signal.removeEventListener('abort', onRendererGone)
          lifetime.dispose()
        }
      })
      lifetime.signal.addEventListener('abort', onRendererGone, { once: true })
      try {
        stream.start()
      } catch (error) {
        stopFrameStream(streamId)
        throw error
      }
      return { streamId }
    }
  )

  ipcMain.handle('emulator:frameStreamStop', (_event, args: { streamId: string }) => {
    stopFrameStream(args.streamId)
  })
}
