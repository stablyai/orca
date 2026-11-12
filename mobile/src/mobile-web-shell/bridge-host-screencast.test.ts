import { describe, expect, it } from 'vitest'
import {
  BrowserScreencastOpcode,
  type BrowserScreencastFrame
} from '../browser/screencast/browser-screencast-protocol'
import { clientFrame } from './bridge-host-test-fakes'
import { harness, ID } from './bridge-host-test-harness'

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
})

// Without the binary grant, keep serving JSON and report locally; never silently grant a lane the route did not request.
describe('the binary lane is served only to a route granted it', () => {
  // The resolved grant list omits both unimplemented and unrequested capabilities; page-route-policy.test.ts pins that filter.
  it('hands it none when the route was not, and still opens the stream', () => {
    const bridge = harness({ ready: true, routeGrants: ['navigate', 'storage'] })
    expect(bridge.last()).toMatchObject({
      type: 'init',
      grants: {
        native: [
          'fault',
          'rpcEnvelope',
          'hostCatalogs',
          'navigate',
          'storage',
          'native.browser.local',
          'native.browser.view'
        ]
      }
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
