import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type {
  EmulatorVideoStreamStartArgs,
  EmulatorVideoStreamMetaMessage,
  EmulatorVideoStreamFrameMessage,
  EmulatorVideoStreamErrorMessage
} from '../../shared/emulator-video-stream'
import { AvccFrameStream } from '../emulator/avcc-frame-stream'
import { scrcpyVideoRegistry } from '../emulator/scrcpy-video-registry'
import { emulatorProbe } from '../emulator/emulator-probe'
import { abortWhenRendererGone } from './renderer-lifetime-abort'

export function registerEmulatorVideoStreamHandlers(): void {
  type Subscription = {
    owner: WebContents
    unsubscribe: () => void
    disposeLifetime: () => void
    startTimer: ReturnType<typeof setTimeout> | null
  }
  const subscriptions = new Map<string, Subscription>()

  const stopSubscription = (streamId: string, owner?: WebContents): void => {
    const subscription = subscriptions.get(streamId)
    if (!subscription || (owner && subscription.owner !== owner)) {
      return
    }
    subscriptions.delete(streamId)
    if (subscription.startTimer !== null) {
      clearTimeout(subscription.startTimer)
    }
    subscription.disposeLifetime()
    subscription.unsubscribe()
  }

  ipcMain.handle('emulator:videoStreamStart', (event, args: EmulatorVideoStreamStartArgs) => {
    const owner = event.sender
    if (!BrowserWindow.fromWebContents(owner)) {
      throw new Error('Emulator video stream must originate from a BrowserWindow.')
    }
    if (typeof args?.deviceId !== 'string') {
      throw new Error('Emulator video stream requires a deviceId string.')
    }
    if (args.streamId !== undefined && typeof args.streamId !== 'string') {
      throw new Error('Emulator video stream requires a streamId string.')
    }
    emulatorProbe('video.subscribe', { deviceId: args.deviceId })
    const streamId = args.streamId ?? randomUUID()
    const existing = subscriptions.get(streamId)
    if (existing && existing.owner !== owner) {
      throw new Error('Video stream id is already in use by another renderer')
    }
    stopSubscription(streamId, owner)
    const lifetime = abortWhenRendererGone(owner)
    const onRendererGone = (): void => stopSubscription(streamId, owner)
    const pendingSubscription: Subscription = {
      owner,
      unsubscribe: () => {},
      disposeLifetime: () => {
        lifetime.signal.removeEventListener('abort', onRendererGone)
        lifetime.dispose()
      },
      startTimer: null
    }
    subscriptions.set(streamId, pendingSubscription)
    lifetime.signal.addEventListener('abort', onRendererGone, { once: true })
    const send = (
      channel:
        | 'emulator:videoStreamMeta'
        | 'emulator:videoStreamFrame'
        | 'emulator:videoStreamError'
        | 'emulator:frameStreamError',
      message:
        | EmulatorVideoStreamMetaMessage
        | EmulatorVideoStreamFrameMessage
        | EmulatorVideoStreamErrorMessage
        | Pick<EmulatorVideoStreamErrorMessage, 'streamId' | 'message'>
    ): void => {
      if (subscriptions.get(streamId) !== pendingSubscription) {
        return
      }
      if (owner.isDestroyed()) {
        stopSubscription(streamId, owner)
        return
      }
      try {
        owner.send(channel, message)
      } catch {
        if (subscriptions.get(streamId) === pendingSubscription) {
          stopSubscription(streamId, owner)
        }
      }
    }
    const onError = (message: string): void => {
      send('emulator:videoStreamError', { streamId, deviceId: args.deviceId, message })
      if (subscriptions.get(streamId) === pendingSubscription) {
        stopSubscription(streamId, owner)
      }
    }
    pendingSubscription.startTimer = setTimeout(() => {
      pendingSubscription.startTimer = null
      if (subscriptions.get(streamId) !== pendingSubscription) {
        return
      }
      if (owner.isDestroyed()) {
        stopSubscription(streamId, owner)
        return
      }
      try {
        if (args.avccStreamUrl !== undefined) {
          const stream = new AvccFrameStream(args.avccStreamUrl, {
            onFrame: (frame) =>
              send('emulator:videoStreamFrame', {
                streamId,
                deviceId: args.deviceId,
                ...frame
              }),
            onError
          })
          pendingSubscription.unsubscribe = () => stream.stop()
          stream.start()
          return
        }
        const unsubscribe = scrcpyVideoRegistry.subscribe(args.deviceId, (videoEvent) => {
          if (videoEvent.type === 'end') {
            send('emulator:frameStreamError', {
              streamId,
              message: 'The Android video stream ended.'
            })
            if (subscriptions.get(streamId) === pendingSubscription) {
              stopSubscription(streamId, owner)
            }
          } else if (videoEvent.type === 'meta') {
            send('emulator:videoStreamMeta', {
              streamId,
              deviceId: args.deviceId,
              meta: videoEvent.meta
            })
          } else {
            send('emulator:videoStreamFrame', {
              streamId,
              deviceId: args.deviceId,
              ...videoEvent.frame
            })
          }
        })
        if (subscriptions.get(streamId) === pendingSubscription) {
          pendingSubscription.unsubscribe = unsubscribe
        } else {
          unsubscribe()
        }
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error))
      }
    }, 0)
    return { streamId }
  })

  ipcMain.handle('emulator:videoStreamStop', (event, args: { streamId: string }) => {
    stopSubscription(args.streamId, event.sender)
  })
}
