/**
 * The binary screencast lane at the host, which is the half `bridge-screencast-binary.ts` was
 * landed without.
 *
 * Read back through the page's own reader and its own decoder rather than against a literal: what
 * matters is that the frame a native listener would have been handed is the frame the page
 * reconstructs, and a shape assertion here could agree with itself while disagreeing with the page.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserScreencastOpcode,
  type BrowserScreencastFrame
} from '../transport/browser-screencast-protocol'
/** The real encoder, wrapped so a case can count the passes it makes over an image. Wrapped rather
 *  than replaced: every other case here reads a frame back through the page's own decoder. */
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
  it('hands the client no binary listener for a plain subscribe', () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(screencastSubscribe(ID))
    expect(bridge.client.streams[0]?.emitBinary).toBeNull()
  })

  it('hands the client a binary listener when the page asked for one', () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(screencastSubscribe(ID, true))
    expect(bridge.client.streams[0]?.emitBinary).toBeInstanceOf(Function)
  })

  it('treats wantsBinary false as no listener at all', () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(screencastSubscribe(ID, false))
    expect(bridge.client.streams[0]?.emitBinary).toBeNull()
  })
})

describe('a binary frame crosses as the event the page decodes', () => {
  it('reconstructs the frame the native listener was handed', () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(screencastSubscribe(ID, true))
    bridge.client.streams[0]?.emitBinary?.(frame(41, IMAGE))
    const event = bridge.last()
    expect(event).toMatchObject({ v: 1, type: 'event', id: ID, seq: 1 })
    const binary = 'binary' in event ? event.binary : null
    expect(binary).not.toBeNull()
    // The decoded frame carries the wire's own base64 beside the bytes (C6.2's data-URI reuse).
    expect(binary === null ? null : decodeBridgeScreencastFrame(binary)).toEqual({
      ...frame(41, IMAGE),
      b64: binary?.b64
    })
  })

  /** One ledger, not two: the page acks by the event seq, so a binary frame that restarted or
   *  skipped it would ack frames the shell never sent. */
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
    emitBinary?.(frame(1, IMAGE))
    expect(bridge.frames().filter((message) => message.type === 'event')).toEqual([])
  })
})

/**
 * The drop rule, and the JSON rule it is scoped away from, in one place.
 *
 * C0.3 ended a stream whose event would not fit, because a hole in a JSON stream is invisible to
 * its reader and a transcript with a gap is worse than one that stopped. A screencast hole is
 * neither: the next frame is one throttle interval away and the pane keeps the last one on screen.
 * So the two verdicts differ by the kind of event, and both are asserted here so neither can be
 * changed into the other by accident.
 */
describe('an over-cap frame drops on the binary lane and ends the stream on the JSON one', () => {
  /** Encoded, this exceeds `BRIDGE_MAX_MESSAGE_BYTES`: 500,000 bytes is 666,668 base64 chars. */
  const OVERSIZED = new Uint8Array(500_000)
  /** The image plus the event frame around it, which is what the cap is applied to — the number
   *  the diagnostic reports is the frame, never the image. */
  const OVERSIZED_FRAME_BYTES = 666_668 + 194

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

  /** The page acks by this number, so a dropped frame must not consume one: a gap would have it
   *  acking a frame the shell never posted. */
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
    // And the window reopens, which is what says the stream was left usable rather than merely open.
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

  /** Per subscription for the diagnostic, total for the surface: a second stream must not restart
   *  the number the dev facts show. */
  it('keeps counting across a second subscription on the same host', () => {
    const bridge = openBinary()
    bridge.client.streams[0]?.emitBinary?.(frame(1, OVERSIZED))
    bridge.host.receive(clientFrame({ type: 'cancel', id: ID, target: 'subscription' }))
    bridge.host.receive(screencastSubscribe(OTHER, true))
    bridge.client.streams[1]?.emitBinary?.(frame(1, OVERSIZED))
    expect(bridge.droppedBinaryFrames).toEqual([1, 2])
    expect(bridge.diagnostics.filter((entry) => entry.kind === 'binary-frame-dropped')).toEqual([
      { kind: 'binary-frame-dropped', id: ID, bytes: OVERSIZED_FRAME_BYTES, dropped: 1 },
      { kind: 'binary-frame-dropped', id: OTHER, bytes: OVERSIZED_FRAME_BYTES, dropped: 1 }
    ])
  })
})

/**
 * The lane is a grant, so the host serves it to a session whose route was given it and to no other.
 *
 * The refusal is the one every grant gets at the call site: nothing is answered, nothing is logged
 * back to the page, and the subscription itself proceeds — a page that asked for binary without the
 * grant gets the JSON stream it would have got before C6.1 existed. Ruling 5 means a page that
 * respects its own `init.grants.native` never reaches this state; this is what holds one that does
 * not.
 */
describe('the binary lane is served only to a route granted it', () => {
  it('hands the client a binary listener when the route was granted the lane', () => {
    const bridge = harness({ ready: true, routeGrants: ['navigate', 'screencastBinary'] })
    bridge.host.receive(screencastSubscribe(ID, true))
    expect(bridge.client.streams[0]?.emitBinary).toBeInstanceOf(Function)
  })

  /**
   * The same list a shell too old to implement the lane produces: `grantsForRoute` filters a route's
   * declared grants through the implemented set, so granted-but-unimplemented and never-granted
   * reach this host as the same absence. `page-route-policy.test.ts` pins that filter.
   */
  it('hands it none when the route was not, and still opens the stream', () => {
    const bridge = harness({ ready: true, routeGrants: ['navigate', 'storage'] })
    bridge.host.receive(screencastSubscribe(ID, true))
    expect(bridge.client.streams[0]?.emitBinary).toBeNull()
    // Not a refusal: the stream is open and its JSON events cross as they always have.
    bridge.client.streams[0]?.emit({ type: 'ready' })
    expect(bridge.frames().filter((message) => message.type === 'event')).toHaveLength(1)
    expect(bridge.frames().filter((message) => message.type === 'error')).toEqual([])
  })

  /**
   * Nothing crosses back for an ungranted ask, so without this the page gets JSON for the life of
   * the document and no side says why. Local only, like every other grant refusal: the wire is
   * exactly what the case above pins.
   */
  it('reports the ungranted ask as a diagnostic and changes nothing on the wire', () => {
    const bridge = harness({ ready: true, routeGrants: ['navigate', 'storage'] })
    bridge.host.receive(screencastSubscribe(ID, true))
    expect(bridge.diagnostics).toEqual([{ kind: 'binary-lane-refused', id: ID }])
    expect(bridge.frames().filter((message) => message.type === 'error')).toEqual([])
  })

  it('says nothing about a page that never asked for the lane', () => {
    const bridge = harness({ ready: true, routeGrants: ['navigate', 'storage'] })
    bridge.host.receive(screencastSubscribe(ID))
    expect(bridge.diagnostics).toEqual([])
  })

  it('says nothing when the route was granted the lane', () => {
    const bridge = harness({ ready: true, routeGrants: ['navigate', 'screencastBinary'] })
    bridge.host.receive(screencastSubscribe(ID, true))
    expect(bridge.diagnostics).toEqual([])
  })

  it('offers the lane in init exactly when it will serve it', () => {
    const granted = harness({ ready: true, routeGrants: ['navigate', 'screencastBinary'] })
    const ungranted = harness({ ready: true, routeGrants: ['navigate', 'storage'] })
    const nativeOf = (bridge: ReturnType<typeof harness>): readonly string[] => {
      const init = bridge.frames().find((message) => message.type === 'init')
      return init?.type === 'init' ? init.grants.native : []
    }
    expect(nativeOf(granted)).toContain('screencastBinary')
    expect(nativeOf(ungranted)).not.toContain('screencastBinary')
  })
})

/**
 * What a stalled page costs the shell.
 *
 * The encode is a base64 pass over the whole image, and the window says whether the frame can be
 * posted at all — so deciding after encoding makes a page that has stopped acking pay for every
 * frame the shell then throws away. The size is knowable without encoding: base64 is ASCII, so JSON
 * escapes none of it and the frame is its envelope plus exactly the image's encoded length.
 */
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
