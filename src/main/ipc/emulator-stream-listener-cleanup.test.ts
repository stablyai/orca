import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Capture the ipcMain handlers the modules register so tests can invoke them
// directly with a fake WebContents owner.
const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, args: unknown) => unknown) => {
      handlers.set(channel, listener)
    }
  },
  // Any non-null return marks the sender as a real BrowserWindow renderer.
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

/** A fake main-window WebContents: a real EventEmitter plus the members the
 * stream handlers touch, so we can assert on its real `destroyed` listeners. */
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

    // 15 show/hide cycles: without the fix this would leave 15 destroyed
    // listeners and trip Node's MaxListenersExceededWarning (default 10).
    for (let i = 0; i < 15; i++) {
      const { streamId } = start(event, { streamUrl: 'http://127.0.0.1:0/stream' }) as {
        streamId: string
      }
      expect(owner.listenerCount('destroyed')).toBe(1)
      stop(event, { streamId })
      expect(owner.listenerCount('destroyed')).toBe(0)
    }
  })

  it('still tears down via the destroyed event when the window closes without a stop', () => {
    registerEmulatorFrameStreamHandlers()
    const start = handlers.get('emulator:frameStreamStart')!
    const owner = makeOwner()

    start({ sender: owner }, { streamUrl: 'http://127.0.0.1:0/stream' })
    expect(owner.listenerCount('destroyed')).toBe(1)

    owner.emit('destroyed')
    // `.once` self-removes after firing; the handler's stop path removes it too
    // (idempotent), so no listener survives the window close.
    expect(owner.listenerCount('destroyed')).toBe(0)
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
