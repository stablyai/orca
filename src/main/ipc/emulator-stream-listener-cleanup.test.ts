import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, args: unknown) => unknown) => {
      handlers.set(channel, listener)
    }
  },
  BrowserWindow: { fromWebContents: () => ({}) }
}))

vi.mock('../emulator/mjpeg-frame-stream', () => ({
  MjpegFrameStream: class {
    start(): void {}
    stop(): void {}
  }
}))

vi.mock('../emulator/scrcpy-video-registry', () => ({
  scrcpyVideoRegistry: { subscribe: () => () => {} }
}))

vi.mock('../emulator/emulator-probe', () => ({ emulatorProbe: () => {} }))

import { registerEmulatorFrameStreamHandlers } from './emulator-frame-stream'
import { registerEmulatorVideoStreamHandlers } from './emulator-video-stream'

/** Keep real EventEmitter destruction listeners behind the fake WebContents. */
function makeOwner(): EventEmitter & { isDestroyed: () => boolean; send: () => void } {
  const owner = new EventEmitter() as EventEmitter & {
    isDestroyed: () => boolean
    send: () => void
  }
  owner.isDestroyed = () => false
  owner.send = () => {}
  return owner
}

beforeEach(() => {
  handlers.clear()
})

describe('emulator frame stream listener cleanup', () => {
  it('removes the destroyed listener on explicit stop and does not accumulate across cycles', () => {
    registerEmulatorFrameStreamHandlers()
    const start = handlers.get('emulator:frameStreamStart')!
    const stop = handlers.get('emulator:frameStreamStop')!
    const owner = makeOwner()
    const event = { sender: owner }

    // Fifteen cycles expose leaks beyond Node's default ten-listener warning threshold.
    for (let i = 0; i < 15; i++) {
      const { streamId } = start(event, { streamUrl: 'http://127.0.0.1:0/stream' }) as {
        streamId: string
      }
      expect(owner.listenerCount('destroyed')).toBe(1)
      stop(event, { streamId })
      expect(owner.listenerCount('destroyed')).toBe(0)
    }
  })
})

describe('emulator video stream listener cleanup', () => {
  it('removes the destroyed listener on explicit stop and does not accumulate across cycles', () => {
    registerEmulatorVideoStreamHandlers()
    const start = handlers.get('emulator:videoStreamStart')!
    const stop = handlers.get('emulator:videoStreamStop')!
    const owner = makeOwner()
    const event = { sender: owner }

    for (let i = 0; i < 15; i++) {
      const { streamId } = start(event, { deviceId: 'emulator-5554' }) as { streamId: string }
      expect(owner.listenerCount('destroyed')).toBe(1)
      stop(event, { streamId })
      expect(owner.listenerCount('destroyed')).toBe(0)
    }
  })
})
