import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import WebSocket from 'ws'
import type {
  EmulatorControlApi,
  EmulatorControlStreamStatus
} from '../../shared/emulator-control-stream'
import { SERVE_SIM_KEYBOARD_MESSAGE_TAG } from '../../shared/emulator-keyboard-frame'
import { SERVE_SIM_TOUCH_MESSAGE_TAG } from '../../shared/emulator-touch-frame'
import { RotateOrientation } from '../../shared/rpc-contract/emulator-params'
import { abortWhenRendererGone } from './renderer-lifetime-abort'

const SERVE_SIM_CONFIG_MESSAGE_TAG = 130
const MAX_SERVE_SIM_CONFIG_BYTES = 1024

function isKeyboardUsage(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff
}

function trackPressedKeyboardUsages(bytes: Uint8Array<ArrayBuffer>, usages: Set<number>): void {
  if (bytes[0] !== SERVE_SIM_KEYBOARD_MESSAGE_TAG) {
    return
  }
  let frame: unknown
  try {
    frame = JSON.parse(
      Buffer.from(bytes.buffer, bytes.byteOffset + 1, bytes.byteLength - 1).toString('utf8')
    )
  } catch {
    return
  }
  if (
    typeof frame !== 'object' ||
    frame === null ||
    !('type' in frame) ||
    !('usage' in frame) ||
    !isKeyboardUsage(frame.usage)
  ) {
    return
  }
  if (frame.type === 'down') {
    usages.add(frame.usage)
  } else if (frame.type === 'up') {
    usages.delete(frame.usage)
  }
}

export function registerEmulatorControlStreamHandlers(): void {
  type Subscription = {
    owner: WebContents
    socket: WebSocket
    pressedKeyboardUsages: Set<number>
    disposeLifetime: () => void
    send: (bytes: Uint8Array<ArrayBuffer>) => void
  }
  const subscriptions = new Map<string, Subscription>()

  const stopSubscription = (streamId: string, subscription: Subscription): void => {
    if (subscriptions.get(streamId) !== subscription) {
      return
    }
    subscriptions.delete(streamId)
    subscription.disposeLifetime()
    if (subscription.socket.readyState === WebSocket.OPEN) {
      // Flush already-sent touch/key releases before the close frame.
      subscription.socket.close()
    } else if (subscription.socket.readyState === WebSocket.CONNECTING) {
      subscription.socket.terminate()
    }
  }

  ipcMain.handle(
    'emulator:controlStreamStart',
    (event, args: Parameters<EmulatorControlApi['startControlStream']>[0]): void => {
      const owner = event.sender
      if (owner.isDestroyed() || !BrowserWindow.fromWebContents(owner)) {
        throw new Error('Emulator control stream must originate from a BrowserWindow.')
      }
      if (typeof args?.streamId !== 'string') {
        throw new Error('Emulator control stream requires a streamId string.')
      }
      if (typeof args.wsUrl !== 'string') {
        throw new Error('Emulator control stream requires a wsUrl string.')
      }
      const url = new URL(args.wsUrl)
      if (
        (url.protocol !== 'ws:' && url.protocol !== 'wss:') ||
        !url.pathname.endsWith('/ws') ||
        /\/(?:exec|devtools)(?:\/|$)/i.test(decodeURIComponent(url.pathname)) ||
        url.hash
      ) {
        throw new Error('Emulator control stream requires a ws/wss URL ending in /ws.')
      }
      const pressedKeyboardUsages = args.pressedKeyboardUsages
      if (
        pressedKeyboardUsages !== undefined &&
        (!Array.isArray(pressedKeyboardUsages) ||
          pressedKeyboardUsages.length > 256 ||
          !pressedKeyboardUsages.every(isKeyboardUsage))
      ) {
        throw new Error('Emulator control stream requires at most 256 valid held keyboard usages.')
      }
      const streamId = args.streamId
      const existing = subscriptions.get(streamId)
      if (existing && existing.owner !== owner) {
        throw new Error('Control stream id is already in use by another renderer')
      }
      if (existing) {
        stopSubscription(streamId, existing)
      }
      const socket = new WebSocket(url, { handshakeTimeout: 10_000 })
      const lifetime = abortWhenRendererGone(owner)
      const onRendererGone = (): void => stopSubscription(streamId, subscription)
      const sendStatus = (
        connected: boolean,
        orientation?: EmulatorControlStreamStatus['orientation']
      ): void => {
        if (subscriptions.get(streamId) !== subscription) {
          return
        }
        if (owner.isDestroyed()) {
          stopSubscription(streamId, subscription)
          return
        }
        try {
          const status: EmulatorControlStreamStatus = { streamId, connected }
          if (orientation !== undefined) {
            status.orientation = orientation
          }
          if (!connected && subscription.pressedKeyboardUsages.size > 0) {
            status.pressedKeyboardUsages = [...subscription.pressedKeyboardUsages]
          }
          owner.send('emulator:controlStreamStatus', status)
        } catch {
          stopSubscription(streamId, subscription)
        }
      }
      const onDisconnected = (): void => {
        sendStatus(false)
        stopSubscription(streamId, subscription)
      }
      const onSend = (error?: Error): void => {
        if (error) {
          onDisconnected()
        }
      }
      const subscription: Subscription = {
        owner,
        socket,
        pressedKeyboardUsages: new Set(pressedKeyboardUsages),
        disposeLifetime: () => {
          lifetime.signal.removeEventListener('abort', onRendererGone)
          lifetime.dispose()
        },
        send: (bytes) => {
          try {
            socket.send(bytes, onSend)
            trackPressedKeyboardUsages(bytes, subscription.pressedKeyboardUsages)
          } catch {
            onDisconnected()
          }
        }
      }
      subscriptions.set(streamId, subscription)
      lifetime.signal.addEventListener('abort', onRendererGone, { once: true })
      socket.once('open', () => sendStatus(true))
      socket.on('message', (data, isBinary) => {
        if (subscriptions.get(streamId) !== subscription) {
          return
        }
        if (owner.isDestroyed()) {
          stopSubscription(streamId, subscription)
          return
        }
        if (
          !isBinary ||
          !Buffer.isBuffer(data) ||
          data.byteLength > MAX_SERVE_SIM_CONFIG_BYTES ||
          data[0] !== SERVE_SIM_CONFIG_MESSAGE_TAG
        ) {
          return
        }
        try {
          const config: unknown = JSON.parse(data.subarray(1).toString('utf8'))
          const orientation =
            typeof config === 'object' && config !== null && 'orientation' in config
              ? RotateOrientation.safeParse(config.orientation)
              : undefined
          if (orientation?.success) {
            sendStatus(true, orientation.data)
          }
        } catch {
          // Ignore malformed configs without interrupting touch/key delivery.
        }
      })
      socket.on('error', onDisconnected)
      socket.once('close', onDisconnected)
      socket.once('unexpected-response', (_request, response) => {
        response.destroy()
        onDisconnected()
      })
    }
  )

  ipcMain.on(
    'emulator:controlFrame',
    (event, args: Parameters<EmulatorControlApi['sendControlFrame']>[0]): void => {
      if (typeof args?.streamId !== 'string') {
        return
      }
      const subscription = subscriptions.get(args.streamId)
      if (!subscription || subscription.owner !== event.sender) {
        return
      }
      const bytes = args.bytes
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength < 2 ||
        bytes.byteLength > 1024 ||
        (bytes[0] !== SERVE_SIM_TOUCH_MESSAGE_TAG && bytes[0] !== SERVE_SIM_KEYBOARD_MESSAGE_TAG) ||
        subscription.socket.readyState !== WebSocket.OPEN
      ) {
        return
      }
      subscription.send(bytes)
    }
  )

  ipcMain.on(
    'emulator:controlStreamStop',
    (event, args: Parameters<EmulatorControlApi['stopControlStream']>[0]): void => {
      if (typeof args?.streamId !== 'string') {
        return
      }
      const subscription = subscriptions.get(args.streamId)
      if (subscription?.owner === event.sender) {
        stopSubscription(args.streamId, subscription)
      }
    }
  )
}
