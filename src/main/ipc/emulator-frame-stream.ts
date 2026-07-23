import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { MjpegFrameStream } from '../emulator/mjpeg-frame-stream'

type FrameStreamSession = {
  owner: WebContents
  stream: MjpegFrameStream
  onOwnerDestroyed: () => void
  nextDeliveryId: number
  inFlightDeliveryId: number | null
  pendingFrame: ArrayBuffer | null
  errorDelivered: boolean
}

export const EMULATOR_FRAME_STREAM_MAX_SESSIONS_TOTAL = 8
export const EMULATOR_FRAME_STREAM_MAX_SESSIONS_PER_RENDERER = 2

const sessions = new Map<string, FrameStreamSession>()

function assertFrameStreamCapacity(owner: WebContents): void {
  let ownerSessionCount = 0
  for (const session of sessions.values()) {
    if (session.owner === owner) {
      ownerSessionCount += 1
    }
  }
  if (ownerSessionCount >= EMULATOR_FRAME_STREAM_MAX_SESSIONS_PER_RENDERER) {
    throw new Error(
      `A renderer can have at most ${EMULATOR_FRAME_STREAM_MAX_SESSIONS_PER_RENDERER} active emulator frame streams.`
    )
  }
  if (sessions.size >= EMULATOR_FRAME_STREAM_MAX_SESSIONS_TOTAL) {
    throw new Error(
      `Orca can have at most ${EMULATOR_FRAME_STREAM_MAX_SESSIONS_TOTAL} active emulator frame streams.`
    )
  }
}

function stopFrameStream(streamId: string, owner: WebContents): void {
  const session = sessions.get(streamId)
  if (!session || session.owner !== owner) {
    return
  }
  sessions.delete(streamId)
  // Why: `.once('destroyed')` self-removes only when that event fires (window
  // close), so an explicit stop must drop it or each show/hide cycle leaks one.
  session.owner.removeListener('destroyed', session.onOwnerDestroyed)
  session.pendingFrame = null
  session.stream.stop()
}

function frameToArrayBuffer(frame: Buffer<ArrayBufferLike>): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(frame.byteLength)
  new Uint8Array(arrayBuffer).set(frame)
  return arrayBuffer
}

function sendFrame(streamId: string, session: FrameStreamSession, bytes: ArrayBuffer): void {
  const deliveryId = session.nextDeliveryId
  session.nextDeliveryId += 1
  session.inFlightDeliveryId = deliveryId
  try {
    session.owner.send('emulator:frameStreamFrame', { streamId, deliveryId, bytes })
  } catch {
    stopFrameStream(streamId, session.owner)
  }
}

function queueFrame(streamId: string, frame: Buffer<ArrayBufferLike>): void {
  const session = sessions.get(streamId)
  if (!session || session.owner.isDestroyed()) {
    return
  }
  const bytes = frameToArrayBuffer(frame)
  if (session.inFlightDeliveryId !== null) {
    session.pendingFrame = bytes
    return
  }
  sendFrame(streamId, session, bytes)
}

function acknowledgeFrame(
  owner: WebContents,
  args: { streamId: string; deliveryId: number }
): void {
  const session = sessions.get(args.streamId)
  if (!session || session.owner !== owner || session.inFlightDeliveryId !== args.deliveryId) {
    return
  }
  session.inFlightDeliveryId = null
  session.errorDelivered = false
  const pendingFrame = session.pendingFrame
  session.pendingFrame = null
  if (pendingFrame) {
    sendFrame(args.streamId, session, pendingFrame)
  }
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
            const session = sessions.get(streamId)
            if (!owner.isDestroyed() && session && !session.errorDelivered) {
              session.errorDelivered = true
              try {
                owner.send('emulator:frameStreamError', { streamId, message })
              } catch {
                stopFrameStream(streamId, owner)
              }
            }
          },
          onFrame: (frame) => queueFrame(streamId, frame)
        },
        args.streamKey
      )

      assertFrameStreamCapacity(owner)
      const onOwnerDestroyed = (): void => stopFrameStream(streamId, owner)
      sessions.set(streamId, {
        owner,
        stream,
        onOwnerDestroyed,
        nextDeliveryId: 1,
        inFlightDeliveryId: null,
        pendingFrame: null,
        errorDelivered: false
      })
      owner.once('destroyed', onOwnerDestroyed)
      try {
        stream.start()
      } catch (error) {
        stopFrameStream(streamId, owner)
        throw error
      }
      return { streamId }
    }
  )

  ipcMain.handle('emulator:frameStreamStop', (event, args: { streamId: string }) => {
    stopFrameStream(args.streamId, event.sender)
  })
  ipcMain.on(
    'emulator:frameStreamFrameAck',
    (event, args: { streamId: string; deliveryId: number }) => {
      if (
        typeof args?.streamId === 'string' &&
        Number.isSafeInteger(args.deliveryId) &&
        args.deliveryId > 0
      ) {
        acknowledgeFrame(event.sender, args)
      }
    }
  )
}
