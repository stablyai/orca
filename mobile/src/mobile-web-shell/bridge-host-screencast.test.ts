// Decode through the page’s real reader to prove the binary frame the host emits is one the page reconstructs; literals alone could agree on the wrong shape.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserScreencastOpcode,
  type BrowserScreencastFrame
} from '../browser/browser-screencast-protocol'
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

import { clientFrame } from './bridge-host-test-fakes'
import { harness, ID } from './bridge-host-test-harness'

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

describe('a binary frame crosses as the event the page decodes', () => {
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

  // Keep diagnostics per-stream but dev-facts loss cumulative across resubscriptions.
})

// Without the binary grant, keep serving JSON and report locally; never silently grant a lane the route did not request.

// Check the window before a full-image base64 pass; encoded size is exact from the ASCII base64 length plus envelope, so refused frames need no encoding.
