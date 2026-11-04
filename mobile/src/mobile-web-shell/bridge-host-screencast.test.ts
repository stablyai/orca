// Decode through the page’s real reader to prove the binary frame the host emits is one the page reconstructs; literals alone could agree on the wrong shape.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserScreencastOpcode,
  type BrowserScreencastFrame
} from '../transport/browser-screencast-protocol'
// Wrap the real encoder to count full-image passes while preserving decoder interoperability.
const encodes = vi.hoisted(() => ({ count: 0 }))
vi.mock('./bridge/bridge-screencast-encoder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bridge/bridge-screencast-encoder')>()
  return {
    ...actual,
    encodeBridgeScreencastFrame: (
      frame: Parameters<typeof actual.encodeBridgeScreencastFrame>[0]
    ) => {
      encodes.count += 1
      return actual.encodeBridgeScreencastFrame(frame)
    }
  }
})

import { decodeBridgeScreencastFrame } from './bridge/bridge-screencast-binary'
import { BRIDGE_MAX_MESSAGE_BYTES } from './bridge/bridge-caps'
import { BRIDGE_MAX_UNACKED_FRAMES } from './bridge-host-subscriptions'
import { clientFrame } from './bridge-host-test-fakes'
import { harness, ID, OTHER } from './bridge-host-test-harness'

beforeEach(() => {
  encodes.count = 0
})

const SCREENCAST = 'browser.screencast'

function screencastSubscribe(id: string, wantsBinary?: boolean): string {
  return clientFrame({
    type: 'subscribe',
    id,
    method: SCREENCAST,
    params: { worktree: 'id:w', page: 'p' },
    ...(wantsBinary === undefined ? {} : { wantsBinary })
  })
}

function frame(seq: number, image: Uint8Array): BrowserScreencastFrame {
  return {
    opcode: BrowserScreencastOpcode.Frame,
    seq,
    format: 'jpeg',
    metadata: { deviceWidth: 390, deviceHeight: 712, imageWidth: 975, imageHeight: 609 },
    image
  }
}

const IMAGE = Uint8Array.from({ length: 512 }, (_, index) => (index * 31 + 7) & 0xff)

describe('the host asks for binary only when the page did', () => {
  it.each([undefined, false])('omits the binary listener when wantsBinary is %s', (wantsBinary) => {
    const bridge = harness({ ready: true })
    bridge.host.receive(screencastSubscribe(ID, wantsBinary))
    expect(bridge.client.streams[0]?.emitBinary).toBeNull()
  })
})

describe('a binary frame crosses as the event the page decodes', () => {
  it('reconstructs the frame the native listener was handed', () => {
    const bridge = harness({ ready: true, routeGrants: ['navigate', 'screencastBinary'] })
    bridge.host.receive(screencastSubscribe(ID, true))
    expect(bridge.last()).toMatchObject({
      type: 'init',
      grants: { native: expect.arrayContaining(['screencastBinary']) }
    })
    const emit = bridge.client.streams[0]?.emitBinary
    if (emit === undefined || emit === null) {
      throw new Error('binary listener missing')
    }
    emit(frame(41, IMAGE))
    expect(bridge.diagnostics).toEqual([])
    const event = bridge.last()
    expect(event).toMatchObject({ v: 1, type: 'event', id: ID, seq: 1 })
    const binary = 'binary' in event ? event.binary : null
    expect(binary).not.toBeNull()
    expect(binary === null ? null : decodeBridgeScreencastFrame(binary)).toEqual({
      ...frame(41, IMAGE),
      b64: binary?.b64
    })
  })

  // JSON and binary share sequence numbers because the page acknowledges one event ledger.
  it('shares one seq sequence with the JSON events of the same stream', () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(screencastSubscribe(ID, true))
    bridge.client.streams[0]?.emit({ type: 'ready' })
    bridge.client.streams[0]?.emitBinary?.(frame(0, IMAGE))
    bridge.client.streams[0]?.emit({ type: 'ready' })
    expect(
      bridge
        .frames()
        .filter((message) => message.type === 'event')
        .map((m) => m.seq)
    ).toEqual([1, 2, 3])
  })

  it('delivers nothing for a stream the page already cancelled', () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(screencastSubscribe(ID, true))
    const emitBinary = bridge.client.streams[0]?.emitBinary
    bridge.host.receive(clientFrame({ type: 'cancel', id: ID, target: 'subscription' }))
    if (emitBinary === undefined || emitBinary === null) {
      throw new Error('binary listener never installed')
    }
    emitBinary(frame(1, IMAGE))
    expect(bridge.frames().filter((message) => message.type === 'event')).toEqual([])
  })
})

// Oversized JSON must end the stream because invisible gaps corrupt state; screencast may drop a frame and retain the last picture until the next.
describe('an over-cap frame drops on the binary lane and ends the stream on the JSON one', () => {
  // 500,000 raw bytes encode to 666,668 base64 characters, exceeding the message cap.
  const OVERSIZED = new Uint8Array(500_000)

  function openBinary(): ReturnType<typeof harness> {
    const bridge = harness({ ready: true })
    bridge.host.receive(screencastSubscribe(ID, true))
    return bridge
  }

  it('drops a binary frame over the frame cap and keeps the stream open', () => {
    const bridge = openBinary()
    bridge.client.streams[0]?.emitBinary?.(frame(1, OVERSIZED))
    expect(bridge.frames().filter((message) => message.type === 'end')).toEqual([])
    bridge.client.streams[0]?.emitBinary?.(frame(2, IMAGE))
    const events = bridge.frames().filter((message) => message.type === 'event')
    expect(events).toHaveLength(1)
    expect(bridge.client.streams[0]?.unsubscribes).toBe(0)
  })

  it('ends a JSON event over the same cap with overflow, as it always has', () => {
    const bridge = openBinary()
    bridge.client.streams[0]?.emit('z'.repeat(BRIDGE_MAX_MESSAGE_BYTES))
    expect(bridge.last()).toEqual({ v: 1, type: 'end', id: ID, reason: 'overflow' })
    expect(bridge.client.streams[0]?.unsubscribes).toBe(1)
  })

  // Dropped frames must not consume a sequence number that the page could acknowledge as sent.
  it('does not spend a seq on a frame it dropped', () => {
    const bridge = openBinary()
    bridge.client.streams[0]?.emitBinary?.(frame(1, IMAGE))
    bridge.client.streams[0]?.emitBinary?.(frame(2, OVERSIZED))
    bridge.client.streams[0]?.emitBinary?.(frame(3, IMAGE))
    expect(
      bridge
        .frames()
        .filter((message) => message.type === 'event')
        .map((message) => message.seq)
    ).toEqual([1, 2])
  })

  it('drops rather than ends when the unacked frame window is full', () => {
    const bridge = openBinary()
    for (let index = 0; index < BRIDGE_MAX_UNACKED_FRAMES + 4; index += 1) {
      bridge.client.streams[0]?.emitBinary?.(frame(index, IMAGE))
    }
    expect(bridge.frames().filter((message) => message.type === 'event')).toHaveLength(
      BRIDGE_MAX_UNACKED_FRAMES
    )
    expect(bridge.frames().filter((message) => message.type === 'end')).toEqual([])
    bridge.host.receive(clientFrame({ type: 'ack', id: ID, seq: BRIDGE_MAX_UNACKED_FRAMES }))
    bridge.client.streams[0]?.emitBinary?.(frame(999, IMAGE))
    expect(bridge.frames().filter((message) => message.type === 'event')).toHaveLength(
      BRIDGE_MAX_UNACKED_FRAMES + 1
    )
  })

  it('counts every dropped frame and reports the running total', () => {
    const bridge = openBinary()
    bridge.client.streams[0]?.emitBinary?.(frame(1, OVERSIZED))
    bridge.client.streams[0]?.emitBinary?.(frame(2, OVERSIZED))
    expect(bridge.droppedBinaryFrames).toEqual([1, 2])
  })

  // Keep diagnostics per-stream but dev-facts loss cumulative across resubscriptions.
  it('keeps counting across a second subscription on the same host', () => {
    const bridge = openBinary()
    bridge.client.streams[0]?.emitBinary?.(frame(1, OVERSIZED))
    bridge.host.receive(clientFrame({ type: 'cancel', id: ID, target: 'subscription' }))
    bridge.host.receive(screencastSubscribe(OTHER, true))
    bridge.client.streams[1]?.emitBinary?.(frame(1, OVERSIZED))
    expect(bridge.droppedBinaryFrames).toEqual([1, 2])
    for (const entry of bridge.diagnostics) {
      if (entry.kind === 'binary-frame-dropped') {
        expect(entry.bytes).toBeGreaterThan(BRIDGE_MAX_MESSAGE_BYTES)
        expect(entry.bytes).toBeGreaterThan(OVERSIZED.byteLength)
      }
    }
    expect(bridge.diagnostics.filter((entry) => entry.kind === 'binary-frame-dropped')).toEqual([
      { kind: 'binary-frame-dropped', id: ID, bytes: expect.any(Number), dropped: 1 },
      { kind: 'binary-frame-dropped', id: OTHER, bytes: expect.any(Number), dropped: 1 }
    ])
  })
})

// Without the binary grant, keep serving JSON and report locally; never silently grant a lane the route did not request.
describe('the binary lane is served only to a route granted it', () => {
  // The resolved grant list omits both unimplemented and unrequested capabilities; page-route-policy.test.ts pins that filter.
  it('hands it none when the route was not, and still opens the stream', () => {
    const bridge = harness({ ready: true, routeGrants: ['navigate', 'storage'] })
    expect(bridge.last()).toMatchObject({
      type: 'init',
      grants: { native: ['fault', 'rpcEnvelope', 'navigate', 'storage'] }
    })
    bridge.host.receive(screencastSubscribe(ID, true))
    expect(bridge.diagnostics).toEqual([{ kind: 'binary-lane-refused', id: ID }])
    expect(bridge.client.streams[0]?.emitBinary).toBeNull()
    bridge.client.streams[0]?.emit({ type: 'ready' })
    expect(bridge.frames().filter((message) => message.type === 'event')).toHaveLength(1)
    expect(bridge.frames().filter((message) => message.type === 'error')).toEqual([])
  })

  it('says nothing about a page that never asked for the lane', () => {
    const bridge = harness({ ready: true, routeGrants: ['navigate', 'storage'] })
    bridge.host.receive(screencastSubscribe(ID))
    expect(bridge.diagnostics).toEqual([])
  })
})

// Check the window before a full-image base64 pass; encoded size is exact from the ASCII base64 length plus envelope, so refused frames need no encoding.
describe('a frame the window cannot carry is never encoded', () => {
  function openBinary(): ReturnType<typeof harness> {
    const bridge = harness({ ready: true })
    bridge.host.receive(screencastSubscribe(ID, true))
    return bridge
  }

  it('encodes nothing once the unacked window is full, and still counts the drops', () => {
    const bridge = openBinary()
    for (let index = 0; index < BRIDGE_MAX_UNACKED_FRAMES; index += 1) {
      bridge.client.streams[0]?.emitBinary?.(frame(index, IMAGE))
    }
    expect(encodes.count).toBe(BRIDGE_MAX_UNACKED_FRAMES)
    encodes.count = 0
    for (let index = 0; index < 10; index += 1) {
      bridge.client.streams[0]?.emitBinary?.(frame(1000 + index, IMAGE))
    }
    expect({ encodes: encodes.count, dropped: bridge.droppedBinaryFrames.length }).toEqual({
      encodes: 0,
      dropped: 10
    })
  })

  it('encodes nothing for a frame that cannot fit the envelope at any size', () => {
    const bridge = openBinary()
    bridge.client.streams[0]?.emitBinary?.(frame(1, new Uint8Array(500_000)))
    expect({ encodes: encodes.count, dropped: bridge.droppedBinaryFrames }).toEqual({
      encodes: 0,
      dropped: [1]
    })
  })

  it('still encodes the frames it can carry', () => {
    const bridge = openBinary()
    bridge.client.streams[0]?.emitBinary?.(frame(1, IMAGE))
    bridge.client.streams[0]?.emitBinary?.(frame(2, IMAGE))
    expect({
      encodes: encodes.count,
      events: bridge.frames().filter((m) => m.type === 'event').length
    }).toEqual({
      encodes: 2,
      events: 2
    })
  })
})
