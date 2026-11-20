import {
  publishToDocuments,
  registerAppHandler,
  appDocumentFor
} from '../app-registry/app-handler-registry'

import { randomUUID } from 'node:crypto'
import { MjpegFrameStream } from '../../emulator/mjpeg-frame-stream'
import { abortWhenRendererGone } from '../renderer-requests/renderer-lifetime-abort'

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
  registerAppHandler(
    'emulator:frameStreamStart',
    (event, args: { streamUrl: string; streamKey?: string }): { streamId: string } => {
      const owner = appDocumentFor(event)
      const ownerWindow = event.windowId
      if (!ownerWindow) {
        throw new Error('Emulator frame stream must originate from a BrowserWindow.')
      }

      const streamId = randomUUID()
      // Main owns MJPEG sockets so Chromium NetworkService restarts cannot interrupt long-lived streams.
      const stream = new MjpegFrameStream(
        args.streamUrl,
        {
          onError: (message) => {
            if (sessions.has(streamId) && !owner.isDestroyed()) {
              publishToDocuments('emulator:frameStreamError', { streamId, message }, owner.caller)
            }
          },
          onFrame: (frame) => {
            if (sessions.has(streamId) && !owner.isDestroyed()) {
              publishToDocuments(
                'emulator:frameStreamFrame',
                {
                  streamId,
                  bytes: frameToArrayBuffer(frame)
                },
                owner.caller
              )
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

  registerAppHandler('emulator:frameStreamStop', (_event, args: { streamId: string }) => {
    stopFrameStream(args.streamId)
  })
}
