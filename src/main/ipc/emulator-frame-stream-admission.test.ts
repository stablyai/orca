import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type StreamMock = {
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

const { handlers, streamState } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
  streamState: {
    instances: [] as StreamMock[],
    startError: null as Error | null
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
  BrowserWindow: {
    fromWebContents: (owner: { isDestroyed: () => boolean }) => (owner.isDestroyed() ? null : {})
  }
}))

vi.mock('../emulator/mjpeg-frame-stream', () => ({
  MjpegFrameStream: class implements StreamMock {
    readonly start = vi.fn(() => {
      if (streamState.startError) {
        throw streamState.startError
      }
    })
    readonly stop = vi.fn()

    constructor() {
      streamState.instances.push(this)
    }
  }
}))

import {
  EMULATOR_FRAME_STREAM_MAX_SESSIONS_PER_RENDERER,
  EMULATOR_FRAME_STREAM_MAX_SESSIONS_TOTAL,
  registerEmulatorFrameStreamHandlers
} from './emulator-frame-stream'

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

function startStream(owner: Owner): string {
  const result = handler('emulator:frameStreamStart')(
    { sender: owner },
    { streamUrl: 'http://127.0.0.1:3100/stream.mjpeg' }
  ) as { streamId: string }
  return result.streamId
}

function stopStream(owner: Owner, streamId: string): void {
  handler('emulator:frameStreamStop')({ sender: owner }, { streamId })
}

function startedStreamCount(): number {
  return streamState.instances.filter((stream) => stream.start.mock.calls.length > 0).length
}

beforeEach(() => {
  handlers.clear()
  streamState.instances.length = 0
  streamState.startError = null
  registerEmulatorFrameStreamHandlers()
})

afterEach(() => {
  for (const owner of owners) {
    owner.destroy()
  }
  owners.length = 0
  streamState.startError = null
})

describe('emulator frame stream admission', () => {
  it('caps active sessions per renderer without affecting another renderer', () => {
    const firstOwner = makeOwner()
    for (let index = 0; index < EMULATOR_FRAME_STREAM_MAX_SESSIONS_PER_RENDERER; index += 1) {
      startStream(firstOwner)
    }

    expect(() => startStream(firstOwner)).toThrow(/renderer can have at most/)
    expect(() => startStream(makeOwner())).not.toThrow()
    expect(startedStreamCount()).toBe(EMULATOR_FRAME_STREAM_MAX_SESSIONS_PER_RENDERER + 1)
  })

  it('caps active sessions across renderers', () => {
    const ownerCount =
      EMULATOR_FRAME_STREAM_MAX_SESSIONS_TOTAL / EMULATOR_FRAME_STREAM_MAX_SESSIONS_PER_RENDERER
    for (let ownerIndex = 0; ownerIndex < ownerCount; ownerIndex += 1) {
      const owner = makeOwner()
      for (
        let streamIndex = 0;
        streamIndex < EMULATOR_FRAME_STREAM_MAX_SESSIONS_PER_RENDERER;
        streamIndex += 1
      ) {
        startStream(owner)
      }
    }

    expect(() => startStream(makeOwner())).toThrow(/Orca can have at most/)
    expect(startedStreamCount()).toBe(EMULATOR_FRAME_STREAM_MAX_SESSIONS_TOTAL)
  })

  it('releases capacity on an owned explicit stop and ignores another renderer', () => {
    const owner = makeOwner()
    const otherOwner = makeOwner()
    const firstStreamId = startStream(owner)
    startStream(owner)
    const firstStream = streamState.instances[0]

    stopStream(otherOwner, firstStreamId)
    expect(firstStream.stop).not.toHaveBeenCalled()
    expect(() => startStream(owner)).toThrow(/renderer can have at most/)

    stopStream(owner, firstStreamId)
    expect(firstStream.stop).toHaveBeenCalledOnce()
    expect(() => startStream(owner)).not.toThrow()
  })

  it('releases every owned session when its renderer is destroyed', () => {
    const owner = makeOwner()
    startStream(owner)
    startStream(owner)
    const ownedStreams = streamState.instances.slice()

    owner.destroy()

    expect(owner.listenerCount('destroyed')).toBe(0)
    for (const stream of ownedStreams) {
      expect(stream.stop).toHaveBeenCalledOnce()
    }
    expect(() => startStream(makeOwner())).not.toThrow()
  })

  it('releases admission and the destroyed listener when start throws', () => {
    const owner = makeOwner()
    const startError = new Error('request setup failed')
    streamState.startError = startError

    expect(() => startStream(owner)).toThrow(startError)
    expect(owner.listenerCount('destroyed')).toBe(0)
    expect(streamState.instances[0].stop).toHaveBeenCalledOnce()

    streamState.startError = null
    for (let index = 0; index < EMULATOR_FRAME_STREAM_MAX_SESSIONS_PER_RENDERER; index += 1) {
      expect(() => startStream(owner)).not.toThrow()
    }
  })
})
