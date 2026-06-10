import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { MjpegFrameStream } from '../emulator/mjpeg-frame-stream'

type FrameStreamSession = {
  owner: WebContents
  stream: MjpegFrameStream
}

const sessions = new Map<string, FrameStreamSession>()

function stopFrameStream(streamId: string): void {
  const session = sessions.get(streamId)
  if (!session) {
    return
  }
  session.stream.stop()
  sessions.delete(streamId)
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
            if (!owner.isDestroyed()) {
              owner.send('emulator:frameStreamError', { streamId, message })
            }
          },
          onFrame: (frame) => {
            if (!owner.isDestroyed()) {
              owner.send('emulator:frameStreamFrame', {
                streamId,
                bytes: frameToArrayBuffer(frame)
              })
            }
          }
        },
        args.streamKey
      )

      sessions.set(streamId, { owner, stream })
      owner.once('destroyed', () => stopFrameStream(streamId))
      stream.start()
      return { streamId }
    }
  )

  ipcMain.handle('emulator:frameStreamStop', (_event, args: { streamId: string }) => {
    stopFrameStream(args.streamId)
  })
}
