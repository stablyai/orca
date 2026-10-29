import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MjpegFrameStreamCallbacks } from '../emulator/mjpeg-frame-stream'
import type { ScrcpyVideoSubscriber } from '../emulator/scrcpy-video-registry'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
  frameCallbacks: new Set<MjpegFrameStreamCallbacks>(),
  videoSubscribers: new Set<ScrcpyVideoSubscriber>(),
  frameStarts: vi.fn(),
  frameStops: vi.fn(),
  videoStarts: vi.fn(),
  videoStops: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) => {
      mocks.handlers.set(channel, handler)
    }
  },
  BrowserWindow: { fromWebContents: () => ({}) }
}))
vi.mock('../emulator/mjpeg-frame-stream', () => ({
  MjpegFrameStream: class {
    constructor(
      _url: string,
      private callbacks: MjpegFrameStreamCallbacks
    ) {}
    start(): void {
      mocks.frameStarts()
      mocks.frameCallbacks.add(this.callbacks)
    }
    stop(): void {
      mocks.frameStops()
      mocks.frameCallbacks.delete(this.callbacks)
    }
  }
}))
vi.mock('../emulator/scrcpy-video-registry', () => ({
  scrcpyVideoRegistry: {
    subscribe: (_deviceId: string, subscriber: ScrcpyVideoSubscriber) => {
      mocks.videoStarts()
      mocks.videoSubscribers.add(subscriber)
      return () => {
        mocks.videoStops()
        mocks.videoSubscribers.delete(subscriber)
      }
    }
  }
}))
vi.mock('../emulator/emulator-probe', () => ({ emulatorProbe: () => {} }))

import { registerEmulatorFrameStreamHandlers } from './emulator-frame-stream'
import { registerEmulatorVideoStreamHandlers } from './emulator-video-stream'

class Owner extends EventEmitter {
  send = vi.fn()
  isDestroyed = (): boolean => false
}

const owners: Owner[] = []
const goneEvents = ['did-navigate', 'render-process-gone', 'destroyed'] as const

function owner(): Owner {
  const sender = new Owner()
  owners.push(sender)
  return sender
}

function start(sender: Owner, kind: 'frame' | 'video'): string {
  const result = mocks.handlers.get(`emulator:${kind}StreamStart`)?.(
    { sender },
    kind === 'frame'
      ? { streamUrl: 'http://127.0.0.1:0/stream.mjpeg' }
      : { deviceId: 'emulator-5554' }
  )
  if (!result || typeof result !== 'object' || !('streamId' in result)) {
    throw new Error('Missing stream result')
  }
  if (typeof result.streamId !== 'string') {
    throw new Error('Missing stream id')
  }
  return result.streamId
}

function sendFrames(): void {
  for (const callbacks of mocks.frameCallbacks) {
    callbacks.onFrame(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  }
  for (const subscriber of mocks.videoSubscribers) {
    subscriber({
      type: 'frame',
      frame: { config: false, keyFrame: true, pts: '0', bytes: new ArrayBuffer(4) }
    })
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  registerEmulatorFrameStreamHandlers()
  registerEmulatorVideoStreamHandlers()
})

afterEach(() => {
  for (const sender of owners.splice(0)) {
    sender.emit('destroyed')
  }
  vi.clearAllTimers()
  vi.useRealTimers()
  mocks.frameCallbacks.clear()
  mocks.videoSubscribers.clear()
})

it.each(goneEvents)('stops both live streams on %s and leaves no per-frame delivery', (event) => {
  const sender = owner()
  start(sender, 'frame')
  start(sender, 'video')
  vi.runOnlyPendingTimers()
  sendFrames()
  expect(sender.send).toHaveBeenCalledTimes(2)

  sender.emit(event)
  expect(mocks.frameCallbacks.size).toBe(0)
  expect(mocks.videoSubscribers.size).toBe(0)
  expect(mocks.frameStops).toHaveBeenCalledTimes(1)
  expect(mocks.videoStops).toHaveBeenCalledTimes(1)
  sendFrames()
  expect(sender.send).toHaveBeenCalledTimes(2)
  for (const gone of goneEvents) {
    expect(sender.listenerCount(gone)).toBe(0)
  }
})

it.each(goneEvents)('does not start deferred video work after %s', (event) => {
  const sender = owner()
  start(sender, 'video')
  sender.emit(event)
  vi.runOnlyPendingTimers()
  expect(mocks.videoStarts).not.toHaveBeenCalled()
  expect(mocks.videoSubscribers.size).toBe(0)
})

it('keeps only the current document streams after repeated reloads', () => {
  const sender = owner()
  for (let cycle = 0; cycle < 15; cycle++) {
    start(sender, 'frame')
    start(sender, 'video')
    vi.runOnlyPendingTimers()
    sender.emit('did-navigate')
  }
  start(sender, 'frame')
  start(sender, 'video')
  vi.runOnlyPendingTimers()
  expect(mocks.frameCallbacks.size).toBe(1)
  expect(mocks.videoSubscribers.size).toBe(1)
  sendFrames()
  expect(sender.send).toHaveBeenCalledTimes(2)
})

it('keeps streams through same-document or prevented navigation and releases on explicit stop', () => {
  const sender = owner()
  const frameId = start(sender, 'frame')
  const videoId = start(sender, 'video')
  vi.runOnlyPendingTimers()
  sender.emit('did-start-navigation')
  sender.emit('did-navigate-in-page')
  sendFrames()
  expect(sender.send).toHaveBeenCalledTimes(2)
  mocks.handlers.get('emulator:frameStreamStop')?.({ sender }, { streamId: frameId })
  mocks.handlers.get('emulator:videoStreamStop')?.({ sender }, { streamId: videoId })
  expect(mocks.frameCallbacks.size).toBe(0)
  expect(mocks.videoSubscribers.size).toBe(0)
  for (const event of goneEvents) {
    expect(sender.listenerCount(event)).toBe(0)
  }
})

it('releases a failed frame-stream start without retaining renderer listeners', () => {
  const sender = owner()
  mocks.frameStarts.mockImplementationOnce(() => {
    throw new Error('Stream unavailable')
  })
  expect(() => start(sender, 'frame')).toThrow('Stream unavailable')
  expect(mocks.frameStops).toHaveBeenCalledTimes(1)
  for (const event of goneEvents) {
    expect(sender.listenerCount(event)).toBe(0)
  }
})

it('keeps another renderer streams live when the first document reloads', () => {
  const first = owner()
  const second = owner()
  for (const sender of [first, second]) {
    start(sender, 'frame')
    start(sender, 'video')
  }
  vi.runOnlyPendingTimers()
  first.emit('did-navigate')
  sendFrames()
  expect(first.send).not.toHaveBeenCalled()
  expect(second.send).toHaveBeenCalledTimes(2)
  expect(mocks.frameCallbacks.size).toBe(1)
  expect(mocks.videoSubscribers.size).toBe(1)
})

it.each([...goneEvents, 'explicit stop'] as const)(
  'suppresses retired frame callbacks after %s while keeping current stream errors',
  (event) => {
    const sender = owner()
    const streamId = start(sender, 'frame')
    const callbacks = [...mocks.frameCallbacks][0]
    callbacks.onError('active failure')
    expect(sender.send).toHaveBeenCalledWith('emulator:frameStreamError', {
      streamId,
      message: 'active failure'
    })
    sender.send.mockClear()
    mocks.frameStops.mockImplementationOnce(() => callbacks.onError('stop failure'))
    if (event === 'explicit stop') {
      mocks.handlers.get('emulator:frameStreamStop')?.({ sender }, { streamId })
    } else {
      sender.emit(event)
    }
    start(sender, 'frame')
    callbacks.onError('late failure')
    callbacks.onFrame(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    expect(sender.send).not.toHaveBeenCalled()
    sendFrames()
    expect(sender.send).toHaveBeenCalledOnce()
  }
)
