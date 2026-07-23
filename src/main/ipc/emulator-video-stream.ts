import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { scrcpyVideoRegistry } from '../emulator/scrcpy-video-registry'
import { emulatorProbe } from '../emulator/emulator-probe'
import { EmulatorVideoFrameDelivery } from './emulator-video-frame-delivery'

export const EMULATOR_VIDEO_STREAM_MAX_SUBSCRIPTIONS_TOTAL = 8
export const EMULATOR_VIDEO_STREAM_MAX_SUBSCRIPTIONS_PER_RENDERER = 2

// Bridges the main-process scrcpy video registry to renderer subscribers. The
// renderer calls emulator:videoStreamStart with a deviceId; meta + H.264 access
// units arrive on emulator:videoStreamMeta / emulator:videoStreamFrame. Mirrors
// the MJPEG emulator-frame-stream handler but for the Android H.264 path.
export function registerEmulatorVideoStreamHandlers(): void {
  type Subscription = {
    owner: WebContents
    unsubscribe: () => void
    onOwnerDestroyed: () => void
    delivery: EmulatorVideoFrameDelivery
    deliveryToken: string
  }
  const subscriptions = new Map<string, Subscription>()

  const assertSubscriptionCapacity = (owner: WebContents): void => {
    let ownerSubscriptionCount = 0
    for (const subscription of subscriptions.values()) {
      if (subscription.owner === owner) {
        ownerSubscriptionCount += 1
      }
    }
    if (ownerSubscriptionCount >= EMULATOR_VIDEO_STREAM_MAX_SUBSCRIPTIONS_PER_RENDERER) {
      throw new Error(
        `A renderer can have at most ${EMULATOR_VIDEO_STREAM_MAX_SUBSCRIPTIONS_PER_RENDERER} active emulator video streams.`
      )
    }
    if (subscriptions.size >= EMULATOR_VIDEO_STREAM_MAX_SUBSCRIPTIONS_TOTAL) {
      throw new Error(
        `Orca can have at most ${EMULATOR_VIDEO_STREAM_MAX_SUBSCRIPTIONS_TOTAL} active emulator video streams.`
      )
    }
  }

  const stopSubscription = (streamId: string, owner?: WebContents): void => {
    const subscription = subscriptions.get(streamId)
    if (!subscription || (owner && subscription.owner !== owner)) {
      return
    }
    subscriptions.delete(streamId)
    // Why: `.once('destroyed')` self-removes only when that event fires (window
    // close), so an explicit stop must drop it or each show/hide cycle leaks one.
    subscription.owner.removeListener('destroyed', subscription.onOwnerDestroyed)
    subscription.delivery.clear()
    subscription.unsubscribe()
  }

  ipcMain.handle(
    'emulator:videoStreamStart',
    (event, args: { deviceId: string; streamId?: string }) => {
      const owner = event.sender
      if (!BrowserWindow.fromWebContents(owner)) {
        throw new Error('Emulator video stream must originate from a BrowserWindow.')
      }
      if (typeof args?.deviceId !== 'string') {
        throw new Error('Emulator video stream requires a deviceId string.')
      }
      emulatorProbe('video.subscribe', { deviceId: args.deviceId })
      const streamId = args.streamId ?? randomUUID()
      const existing = subscriptions.get(streamId)
      if (existing && existing.owner !== owner) {
        throw new Error('Video stream id is already in use by another renderer')
      }
      stopSubscription(streamId, owner)
      assertSubscriptionCapacity(owner)
      const onOwnerDestroyed = (): void => stopSubscription(streamId, owner)
      const deliveryToken = randomUUID()
      const delivery = new EmulatorVideoFrameDelivery((frame, deliveryId) => {
        const current = subscriptions.get(streamId)
        if (!current || current.delivery !== delivery || owner.isDestroyed()) {
          return
        }
        try {
          owner.send('emulator:videoStreamFrame', {
            streamId,
            deliveryToken,
            deliveryId,
            deviceId: args.deviceId,
            ...frame
          })
        } catch {
          stopSubscription(streamId, owner)
        }
      })
      const pendingSubscription: Subscription = {
        owner,
        unsubscribe: () => {},
        onOwnerDestroyed,
        delivery,
        deliveryToken
      }
      subscriptions.set(streamId, pendingSubscription)
      setTimeout(() => {
        if (owner.isDestroyed() || subscriptions.get(streamId) !== pendingSubscription) {
          return
        }
        try {
          const unsubscribe = scrcpyVideoRegistry.subscribe(args.deviceId, (videoEvent) => {
            if (owner.isDestroyed() || subscriptions.get(streamId) !== pendingSubscription) {
              return
            }
            if (videoEvent.type === 'meta') {
              try {
                owner.send('emulator:videoStreamMeta', {
                  streamId,
                  deviceId: args.deviceId,
                  meta: videoEvent.meta
                })
              } catch {
                stopSubscription(streamId, owner)
              }
            } else {
              delivery.enqueue(videoEvent.frame)
            }
          })
          if (subscriptions.get(streamId) !== pendingSubscription) {
            unsubscribe()
            return
          }
          pendingSubscription.unsubscribe = unsubscribe
        } catch {
          stopSubscription(streamId, owner)
        }
      }, 0)
      owner.once('destroyed', onOwnerDestroyed)
      return { streamId }
    }
  )

  ipcMain.handle('emulator:videoStreamStop', (event, args: { streamId: string }) => {
    stopSubscription(args.streamId, event.sender)
  })
  ipcMain.on(
    'emulator:videoStreamFrameAck',
    (event, args: { streamId: string; deliveryToken: string; deliveryId: number }) => {
      const subscription =
        typeof args?.streamId === 'string' ? subscriptions.get(args.streamId) : undefined
      if (
        subscription?.owner === event.sender &&
        args.deliveryToken === subscription.deliveryToken &&
        Number.isSafeInteger(args.deliveryId) &&
        args.deliveryId > 0
      ) {
        subscription.delivery.acknowledge(args.deliveryId)
      }
    }
  )
}
