import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { MjpegFrameStream } from '../emulator/mjpeg-frame-stream'

type FrameStreamSession = {
  owner: WebContents
  stream: MjpegFrameStream
  onOwnerDestroyed: () => void
}

const sessions = new Map<string, FrameStreamSession>()

function stopFrameStream(streamId: string): void {
  const session = sessions.get(streamId)
  if (!session) {
    return
  }
  session.stream.stop()
  // Why: `.once('destroyed')` self-removes only when that event fires (window
  // close), so an explicit stop must drop it or each show/hide cycle leaks one.
  session.owner.removeListener('destroyed', session.onOwnerDestroyed)
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

      const onOwnerDestroyed = (): void => stopFrameStream(streamId)
      sessions.set(streamId, { owner, stream, onOwnerDestroyed })
      owner.once('destroyed', onOwnerDestroyed)
      stream.start()
      return { streamId }
    }
  )

  ipcMain.handle('emulator:frameStreamStop', (_event, args: { streamId: string }) => {
    stopFrameStream(args.streamId)
  })
}
