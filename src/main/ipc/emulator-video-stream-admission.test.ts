import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type VideoEvent =
  | { type: 'meta'; meta: { codecId: string; width: number; height: number } }
  | {
      type: 'frame'
      frame: {
        config: boolean
        keyFrame: boolean
        pts: string
        bytes: ArrayBuffer
      }
    }

const { handlers, registryState, subscribeMock } = vi.hoisted(() => {
  const state = {
    error: null as Error | null,
    subscribers: [] as ((event: VideoEvent) => void)[],
    unsubscribes: [] as ReturnType<typeof vi.fn>[]
  }
  return {
    handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
    registryState: state,
    subscribeMock: vi.fn((_deviceId: string, subscriber: (event: VideoEvent) => void) => {
      if (state.error) {
        throw state.error
      }
      const unsubscribe = vi.fn()
      state.subscribers.push(subscriber)
      state.unsubscribes.push(unsubscribe)
      return unsubscribe
    })
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, args: unknown) => unknown): void => {
      handlers.set(channel, listener)
    },
    on: (channel: string, listener: (event: unknown, args: unknown) => unknown): void => {
      handlers.set(channel, listener)
    }
  },
  BrowserWindow: {
    fromWebContents: (owner: { isDestroyed: () => boolean }) => (owner.isDestroyed() ? null : {})
  }
}))

vi.mock('../emulator/scrcpy-video-registry', () => ({
  SCRCPY_VIDEO_MAX_GOP_FRAMES: 120,
  SCRCPY_VIDEO_MAX_REPLAY_BYTES_PER_DEVICE: 32 * 1024 * 1024,
  scrcpyVideoRegistry: { subscribe: subscribeMock }
}))

vi.mock('../emulator/emulator-probe', () => ({ emulatorProbe: vi.fn() }))

import {
  EMULATOR_VIDEO_STREAM_MAX_SUBSCRIPTIONS_PER_RENDERER,
  EMULATOR_VIDEO_STREAM_MAX_SUBSCRIPTIONS_TOTAL,
  registerEmulatorVideoStreamHandlers
} from './emulator-video-stream'

type Owner = EventEmitter & {
  destroy: () => void
  isDestroyed: () => boolean
  send: ReturnType<typeof vi.fn>
}

const owners: Owner[] = []

function makeOwner(): Owner {
  let destroyed = false
  const owner = new EventEmitter() as Owner
  owner.isDestroyed = () => destroyed
  owner.send = vi.fn()
  owner.destroy = () => {
    if (destroyed) {
      return
    }
    destroyed = true
    owner.emit('destroyed')
  }
  owners.push(owner)
  return owner
}

function handler(channel: string): (event: unknown, args: unknown) => unknown {
  const registered = handlers.get(channel)
  if (!registered) {
    throw new Error(`Missing handler for ${channel}`)
  }
  return registered
}

function startStream(owner: Owner, streamId: string): void {
  handler('emulator:videoStreamStart')({ sender: owner }, { deviceId: 'emulator-5554', streamId })
}

function stopStream(owner: Owner, streamId: string): void {
  handler('emulator:videoStreamStop')({ sender: owner }, { streamId })
}

beforeEach(() => {
  vi.useFakeTimers()
  handlers.clear()
  registryState.error = null
  registryState.subscribers.length = 0
  registryState.unsubscribes.length = 0
  subscribeMock.mockClear()
  registerEmulatorVideoStreamHandlers()
})

afterEach(() => {
  for (const owner of owners) {
    owner.destroy()
  }
  owners.length = 0
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
})

describe('emulator video stream admission', () => {
  it('caps subscriptions per renderer without affecting another renderer', () => {
    const owner = makeOwner()
    for (let index = 0; index < EMULATOR_VIDEO_STREAM_MAX_SUBSCRIPTIONS_PER_RENDERER; index += 1) {
      startStream(owner, `owned-${index}`)
    }

    expect(() => startStream(owner, 'overflow')).toThrow(/renderer can have at most/)
    expect(() => startStream(makeOwner(), 'other-renderer')).not.toThrow()
  })

  it('caps subscriptions across renderers before registry fan-out begins', () => {
    const ownerCount =
      EMULATOR_VIDEO_STREAM_MAX_SUBSCRIPTIONS_TOTAL /
      EMULATOR_VIDEO_STREAM_MAX_SUBSCRIPTIONS_PER_RENDERER
    for (let ownerIndex = 0; ownerIndex < ownerCount; ownerIndex += 1) {
      const owner = makeOwner()
      for (
        let streamIndex = 0;
        streamIndex < EMULATOR_VIDEO_STREAM_MAX_SUBSCRIPTIONS_PER_RENDERER;
        streamIndex += 1
      ) {
        startStream(owner, `${ownerIndex}-${streamIndex}`)
      }
    }

    expect(() => startStream(makeOwner(), 'overflow')).toThrow(/Orca can have at most/)
    expect(subscribeMock).not.toHaveBeenCalled()
  })

  it('allows owned replacement and stop without cross-renderer capacity changes', () => {
    const owner = makeOwner()
    const otherOwner = makeOwner()
    startStream(owner, 'first')
    startStream(owner, 'second')
    vi.runOnlyPendingTimers()
    const firstUnsubscribe = registryState.unsubscribes[0]

    startStream(owner, 'first')
    expect(firstUnsubscribe).toHaveBeenCalledOnce()
    expect(owner.listenerCount('destroyed')).toBe(2)

    stopStream(otherOwner, 'first')
    expect(() => startStream(owner, 'overflow')).toThrow(/renderer can have at most/)

    stopStream(owner, 'first')
    expect(() => startStream(owner, 'replacement')).not.toThrow()
  })

  it('releases pending subscriptions when the renderer is destroyed', () => {
    const owner = makeOwner()
    startStream(owner, 'first')
    startStream(owner, 'second')

    owner.destroy()
    vi.runOnlyPendingTimers()

    expect(owner.listenerCount('destroyed')).toBe(0)
    expect(subscribeMock).not.toHaveBeenCalled()
    const nextOwner = makeOwner()
    expect(() => startStream(nextOwner, 'next-first')).not.toThrow()
    expect(() => startStream(nextOwner, 'next-second')).not.toThrow()
  })

  it('releases admission when synchronous registry replay throws', () => {
    const owner = makeOwner()
    registryState.error = new Error('renderer send failed')
    startStream(owner, 'failing')

    vi.runOnlyPendingTimers()

    expect(owner.listenerCount('destroyed')).toBe(0)
    registryState.error = null
    for (let index = 0; index < EMULATOR_VIDEO_STREAM_MAX_SUBSCRIPTIONS_PER_RENDERER; index += 1) {
      expect(() => startStream(owner, `recovered-${index}`)).not.toThrow()
    }
  })

  it('sends one H.264 frame at a time and requires the exact delivery token', () => {
    const owner = makeOwner()
    startStream(owner, 'bounded')
    vi.runOnlyPendingTimers()
    const subscriber = registryState.subscribers[0]

    for (let index = 0; index < 20; index += 1) {
      subscriber({
        type: 'frame',
        frame: {
          config: false,
          keyFrame: index === 0,
          pts: String(index),
          bytes: new ArrayBuffer(1)
        }
      })
    }
    const frameCalls = () =>
      owner.send.mock.calls.filter(([channel]) => channel === 'emulator:videoStreamFrame')
    expect(frameCalls()).toHaveLength(1)
    const firstPayload = frameCalls()[0][1] as {
      deliveryToken: string
      deliveryId: number
    }

    handler('emulator:videoStreamFrameAck')(
      { sender: owner },
      { streamId: 'bounded', deliveryToken: 'stale', deliveryId: 1 }
    )
    expect(frameCalls()).toHaveLength(1)

    handler('emulator:videoStreamFrameAck')(
      { sender: owner },
      {
        streamId: 'bounded',
        deliveryToken: firstPayload.deliveryToken,
        deliveryId: firstPayload.deliveryId
      }
    )
    expect(frameCalls()).toHaveLength(2)
  })
})
