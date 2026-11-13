import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import WebSocket from 'ws'
import type { EmulatorBridge } from '../emulator/emulator-bridge'
import type { EmulatorControlStreamEvent } from '../../preload/api/emulator-api'
import { abortWhenRendererGone } from './renderer-lifetime-abort'
import { registerEmulatorScrcpyTouchHandler } from './emulator-scrcpy-touch'
import { registerEmulatorScrcpyKeyboardHandler } from './emulator-scrcpy-keyboard'

export function registerEmulatorControlStreamHandlers(
  getBridge: () => EmulatorBridge | null
): void {
  registerEmulatorScrcpyTouchHandler()
  registerEmulatorScrcpyKeyboardHandler()
  const streams = new Map<string, { owner: WebContents; socket: WebSocket; dispose: () => void }>()
  const stop = (streamId: string, owner: WebContents): void => {
    const stream = streams.get(streamId)
    if (!stream || stream.owner !== owner) {
      return
    }
    streams.delete(streamId)
    stream.dispose()
    // close() flushes queued release frames; terminate() would drop them.
    if (stream.socket.readyState === WebSocket.OPEN) {
      stream.socket.close()
    } else {
      stream.socket.terminate()
    }
  }

  ipcMain.handle(
    'emulator:controlStreamStart',
    (event, args: { wsUrl: string; streamId: string }) => {
      const owner = event.sender
      if (!BrowserWindow.fromWebContents(owner) || !getBridge()?.hasControlStreamUrl(args?.wsUrl)) {
        throw new Error('Control stream requires a registered emulator session.')
      }
      const { streamId } = args
      if (typeof streamId !== 'string' || streams.has(streamId)) {
        throw new Error('Control stream id is invalid or already in use.')
      }
      const socket = new WebSocket(args.wsUrl)
      socket.binaryType = 'arraybuffer'
      const lifetime = abortWhenRendererGone(owner)
      const onGone = (): void => stop(streamId, owner)
      streams.set(streamId, {
        owner,
        socket,
        dispose: () => {
          lifetime.signal.removeEventListener('abort', onGone)
          lifetime.dispose()
        }
      })
      lifetime.signal.addEventListener('abort', onGone, { once: true })
      const send = (
        type: EmulatorControlStreamEvent['type'],
        data?: ArrayBuffer | string
      ): void => {
        if (streams.has(streamId) && !owner.isDestroyed()) {
          owner.send('emulator:controlStreamEvent', { streamId, type, data })
        }
      }
      socket.on('open', () => send('open'))
      socket.on('message', (data) =>
        send('message', data instanceof ArrayBuffer ? data : data.toString())
      )
      socket.on('error', (error) => send('error', error.message))
      socket.on('close', () => {
        send('close')
        stop(streamId, owner)
      })
    }
  )
  ipcMain.on(
    'emulator:controlStreamSend',
    (event, args: { streamId: string; data: string | Uint8Array } | null) => {
      const stream = args && streams.get(args.streamId)
      if (
        args &&
        stream?.owner === event.sender &&
        stream.socket.readyState === WebSocket.OPEN &&
        (typeof args.data === 'string' || args.data instanceof Uint8Array)
      ) {
        stream.socket.send(args.data)
      }
    }
  )
  ipcMain.handle('emulator:controlStreamStop', (event, args: { streamId: string }) => {
    stop(args.streamId, event.sender)
  })
}
