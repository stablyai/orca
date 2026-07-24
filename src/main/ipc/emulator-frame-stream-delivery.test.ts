import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type StreamCallbacks = {
  onError: (message: string) => void
  onFrame: (frame: Buffer<ArrayBufferLike>) => void
}

const { handlers, streamState } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
  streamState: {
    callbacks: [] as StreamCallbacks[]
  }
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, args: unknown) => unknown): void => {
      handlers.set(channel, listener)
    },
    on: (channel: string, listener: (event: unknown, args: unknown) => unknown): void => {
      handlers.set(channel, listener)
    }
  },
  BrowserWindow: { fromWebContents: () => ({}) }
}))

vi.mock('../emulator/mjpeg-frame-stream', () => ({
  MjpegFrameStream: class {
    readonly start = vi.fn()
    readonly stop = vi.fn()

    constructor(_url: string, callbacks: StreamCallbacks) {
      streamState.callbacks.push(callbacks)
    }
  }
}))

import { registerEmulatorFrameStreamHandlers } from './emulator-frame-stream'

type Owner = EventEmitter & {
  isDestroyed: () => boolean
  send: ReturnType<typeof vi.fn>
}

function makeOwner(): Owner {
  const owner = new EventEmitter() as Owner
  owner.isDestroyed = () => false
  owner.send = vi.fn()
  return owner
}

function handler(channel: string): (event: unknown, args: unknown) => unknown {
  const registered = handlers.get(channel)
  if (!registered) {
    throw new Error(`Missing handler for ${channel}`)
  }
  return registered
}

function startStream(owner: Owner): string {
  return (
    handler('emulator:frameStreamStart')(
      { sender: owner },
      { streamUrl: 'http://127.0.0.1:3100/stream.mjpeg' }
    ) as { streamId: string }
  ).streamId
}

function frameMessages(owner: Owner): {
  streamId: string
  deliveryId: number
  bytes: ArrayBuffer
}[] {
  return owner.send.mock.calls
    .filter(([channel]) => channel === 'emulator:frameStreamFrame')
    .map(([, payload]) => payload)
}

beforeEach(() => {
  handlers.clear()
  streamState.callbacks.length = 0
  registerEmulatorFrameStreamHandlers()
})

describe('emulator frame stream delivery', () => {
  it('keeps only the latest frame while waiting for an exact renderer ack', () => {
    const owner = makeOwner()
    const otherOwner = makeOwner()
    const streamId = startStream(owner)
    const callbacks = streamState.callbacks[0]

    for (let value = 0; value < 100; value += 1) {
      callbacks.onFrame(Buffer.from([value]))
    }

    expect(frameMessages(owner)).toHaveLength(1)
    expect([...new Uint8Array(frameMessages(owner)[0].bytes)]).toEqual([0])

    handler('emulator:frameStreamFrameAck')({ sender: otherOwner }, { streamId, deliveryId: 1 })
    expect(frameMessages(owner)).toHaveLength(1)

    handler('emulator:frameStreamFrameAck')({ sender: owner }, { streamId, deliveryId: 1 })
    expect(frameMessages(owner)).toHaveLength(2)
    expect(frameMessages(owner)[1].deliveryId).toBe(2)
    expect([...new Uint8Array(frameMessages(owner)[1].bytes)]).toEqual([99])

    handler('emulator:frameStreamFrameAck')({ sender: owner }, { streamId, deliveryId: 1 })
    expect(frameMessages(owner)).toHaveLength(2)
  })

  it('coalesces repeated errors until the renderer proves progress', () => {
    const owner = makeOwner()
    const streamId = startStream(owner)
    const callbacks = streamState.callbacks[0]

    callbacks.onError('first')
    callbacks.onError('second')
    expect(
      owner.send.mock.calls.filter(([channel]) => channel === 'emulator:frameStreamError')
    ).toHaveLength(1)

    callbacks.onFrame(Buffer.from([1]))
    handler('emulator:frameStreamFrameAck')({ sender: owner }, { streamId, deliveryId: 1 })
    callbacks.onError('after progress')
    expect(
      owner.send.mock.calls.filter(([channel]) => channel === 'emulator:frameStreamError')
    ).toHaveLength(2)
  })

  it('drops retained delivery state when the stream stops', () => {
    const owner = makeOwner()
    const streamId = startStream(owner)
    const callbacks = streamState.callbacks[0]
    callbacks.onFrame(Buffer.from([1]))
    callbacks.onFrame(Buffer.from([2]))

    handler('emulator:frameStreamStop')({ sender: owner }, { streamId })
    callbacks.onFrame(Buffer.from([3]))
    handler('emulator:frameStreamFrameAck')({ sender: owner }, { streamId, deliveryId: 1 })

    expect(frameMessages(owner)).toHaveLength(1)
  })
})
