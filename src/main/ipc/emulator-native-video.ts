import { BrowserWindow, ipcMain, MessageChannelMain, type WebContents } from 'electron'
import { nativeAndroidSessions } from '../emulator/android/emulator-grpc-session'
import type { NativeVideoFrame, NativeVideoRequest } from '../../shared/emulator-native-video'
import { abortWhenRendererGone } from './renderer-lifetime-abort'

/** Renderer-owned subscriptions retain one in-flight and one latest frame, bounding IPC memory. */
export function registerEmulatorNativeVideoHandlers(): void {
  type Subscription = { owner: WebContents; deviceId: string; stop: () => void }
  const subscriptions = new Map<string, Subscription>()
  ipcMain.handle('emulator:nativeVideoStart', (event, args: NativeVideoRequest) => {
    const owner = event.sender
    if (!BrowserWindow.fromWebContents(owner) || !validRequest(args)) {
      throw new Error('Invalid native emulator subscription')
    }
    const session = nativeAndroidSessions.get(args.deviceId)
    if (!session) {
      throw new Error('Native emulator session ended')
    }
    const previous = subscriptions.get(args.streamId)
    if (previous && previous.owner !== owner) {
      throw new Error('Emulator subscription belongs to another renderer')
    }
    previous?.stop()
    for (const subscription of subscriptions.values()) {
      if (subscription.owner === owner && subscription.deviceId === args.deviceId) {
        subscription.stop()
      }
    }
    const lifetime = abortWhenRendererGone(owner)
    const { port1, port2 } = new MessageChannelMain()
    let pending: NativeVideoFrame | null = null
    let inFlight: NativeVideoFrame | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe = () => {}
    let stopped = false
    let droppedFrames = 0
    const stop = () => {
      if (stopped) {
        return
      }
      stopped = true
      subscriptions.delete(args.streamId)
      pending = inFlight = null
      clearTimeout(timer)
      lifetime.signal.removeEventListener('abort', stop)
      lifetime.dispose()
      unsubscribe()
      port1.close()
    }
    const fail = (message: string, retryWithScrcpy = false) => {
      if (stopped) {
        return
      }
      if (!owner.isDestroyed()) {
        owner.send('emulator:frameStreamError', {
          streamId: args.streamId,
          message,
          retryWithScrcpy
        })
      }
      stop()
    }
    const send = (frame: NativeVideoFrame) => {
      if (owner.isDestroyed()) {
        stop()
        return
      }
      inFlight = frame
      // The port bypasses contextBridge's extra byte-array clone.
      try {
        port1.postMessage({ ...frame, droppedFrames })
      } catch {
        stop()
        return
      }
      timer = setTimeout(() => fail('Native emulator renderer stopped acknowledging frames'), 5000)
    }
    port1.on('message', ({ data }) => {
      if (
        data?.type === 'presented' &&
        Number.isInteger(data.rotation) &&
        data.rotation >= 0 &&
        data.rotation <= 3
      ) {
        session.setInputRotation(data.rotation)
      }
      if (data?.type === 'ack' && inFlight) {
        clearTimeout(timer)
        inFlight = null
        const next = pending
        pending = null
        if (next) {
          send(next)
        }
      }
    })
    port1.on('close', stop)
    port1.start()
    subscriptions.set(args.streamId, { owner, deviceId: args.deviceId, stop })
    lifetime.signal.addEventListener('abort', stop, { once: true })
    try {
      owner.postMessage('emulator:nativeVideoPort', { streamId: args.streamId }, [port2])
      unsubscribe = session.subscribe({
        width: args.width,
        height: args.height,
        frame: (frame) => {
          if (inFlight) {
            if (pending) {
              droppedFrames++
            }
            pending = frame
          } else {
            send(frame)
          }
        },
        end: (retryWithScrcpy) => fail('Native emulator stream ended', retryWithScrcpy)
      })
    } catch (error) {
      stop()
      throw error
    }
    if (stopped) {
      unsubscribe()
    } else if (lifetime.signal.aborted) {
      stop()
    }
  })
  ipcMain.handle('emulator:nativeVideoStop', (event, streamId: string) => {
    const subscription = subscriptions.get(streamId)
    if (subscription?.owner === event.sender) {
      subscription.stop()
    }
  })
}

/** Treat renderer dimensions and subscription identifiers as untrusted allocation inputs. */
function validRequest(args: NativeVideoRequest): boolean {
  return Boolean(
    args &&
    typeof args.deviceId === 'string' &&
    typeof args.streamId === 'string' &&
    args.streamId.length <= 128 &&
    Number.isInteger(args.width) &&
    args.width > 0 &&
    args.width <= 4096 &&
    Number.isInteger(args.height) &&
    args.height > 0 &&
    args.height <= 4096
  )
}
