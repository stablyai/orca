import { describe, expect, it, vi } from 'vitest'
import {
  subscribeFrameStreamFrames,
  subscribeVideoStreamFrames
} from './emulator-stream-frame-listeners'

type Listener = (event: Electron.IpcRendererEvent, data: never) => void

function makeIpcRenderer() {
  const listeners = new Map<string, Listener>()
  return {
    ipcRenderer: {
      on: vi.fn((channel: string, listener: Listener) => {
        listeners.set(channel, listener)
      }),
      removeListener: vi.fn((channel: string, listener: Listener) => {
        if (listeners.get(channel) === listener) {
          listeners.delete(channel)
        }
      }),
      send: vi.fn()
    },
    listeners
  }
}

describe('emulator stream frame listeners', () => {
  it('acknowledges an MJPEG frame after the renderer callback', () => {
    const { ipcRenderer, listeners } = makeIpcRenderer()
    const callback = vi.fn()
    const unsubscribe = subscribeFrameStreamFrames(ipcRenderer as never, callback)
    const bytes = new ArrayBuffer(2)

    listeners.get('emulator:frameStreamFrame')!(
      {} as Electron.IpcRendererEvent,
      {
        streamId: 'frame-stream',
        deliveryId: 7,
        bytes
      } as never
    )

    expect(callback).toHaveBeenCalledWith({ streamId: 'frame-stream', bytes })
    expect(ipcRenderer.send).toHaveBeenCalledWith('emulator:frameStreamFrameAck', {
      streamId: 'frame-stream',
      deliveryId: 7
    })
    unsubscribe()
    expect(listeners.has('emulator:frameStreamFrame')).toBe(false)
  })

  it('acknowledges an H.264 frame even when the renderer callback throws', () => {
    const { ipcRenderer, listeners } = makeIpcRenderer()
    const callback = vi.fn(() => {
      throw new Error('decode failed')
    })
    subscribeVideoStreamFrames(ipcRenderer as never, callback)

    expect(() =>
      listeners.get('emulator:videoStreamFrame')!(
        {} as Electron.IpcRendererEvent,
        {
          streamId: 'video-stream',
          deliveryToken: 'delivery-token',
          deliveryId: 9,
          deviceId: 'emulator-5554',
          config: false,
          keyFrame: true,
          bytes: new ArrayBuffer(1)
        } as never
      )
    ).toThrow('decode failed')
    expect(ipcRenderer.send).toHaveBeenCalledWith('emulator:videoStreamFrameAck', {
      streamId: 'video-stream',
      deliveryToken: 'delivery-token',
      deliveryId: 9
    })
  })
})
