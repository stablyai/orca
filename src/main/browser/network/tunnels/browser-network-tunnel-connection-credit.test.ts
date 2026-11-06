import { describe, expect, it } from 'vitest'
import {
  BROWSER_NETWORK_TUNNEL_IDLE_STREAM_MS,
  BrowserNetworkTunnelConnectionCredit
} from './browser-network-tunnel-connection-credit'
import {
  BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
  BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL
} from './browser-network-tunnel-stream-state'

const MIB = 1024 * 1024
const LEGACY = BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES
const POOL = BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL.connectionWindow!.toClientBytes

function setup() {
  let now = 0
  const credit = new BrowserNetworkTunnelConnectionCredit(
    BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL,
    'client',
    () => now
  )
  const stream = (id: number) => ({ id, windowBytes: 2 * MIB, receiveWindowBytes: LEGACY })
  // Grows a stream to its full window by receiving and consuming, ending drained.
  const grow = (s: ReturnType<typeof stream>) => {
    while (s.receiveWindowBytes < s.windowBytes) {
      credit.receive(s.id, LEGACY)
      if (credit.replenishReceiveWindow(s, LEGACY, true) === 0) {
        return
      }
    }
  }
  return { credit, stream, grow, advance: (ms: number) => (now += ms) }
}

describe('BrowserNetworkTunnelConnectionCredit receive growth', () => {
  it('charges growth while held, so recently active streams cap growth at the pool', () => {
    const { stream, grow } = setup()
    const streams = Array.from({ length: 16 }, (_, id) => stream(id + 1))
    streams.forEach(grow)

    const grownTotal = streams.reduce((total, s) => total + s.receiveWindowBytes - LEGACY, 0)
    expect(grownTotal).toBe(POOL)
  })

  it('releases only idle streams, and only when another stream needs the pool', () => {
    const { credit, stream, grow, advance } = setup()
    const idle = Array.from({ length: 9 }, (_, id) => stream(id + 1))
    idle.forEach(grow)
    const fresh = stream(100)

    // Drained but not yet idle: the grown streams keep their charge.
    advance(BROWSER_NETWORK_TUNNEL_IDLE_STREAM_MS - 1)
    credit.receive(fresh.id, 2 * LEGACY)
    expect(credit.replenishReceiveWindow(fresh, 2 * LEGACY, true)).toBe(
      POOL - 9 * (2 * MIB - LEGACY)
    )

    advance(1)
    credit.receive(fresh.id, 2 * LEGACY)
    expect(credit.replenishReceiveWindow(fresh, 2 * LEGACY, true)).toBe(2 * LEGACY)
  })

  it('shrinks a woken idle stream by withholding credit while the pool is overcommitted', () => {
    const { credit, stream, grow, advance } = setup()
    const idle = Array.from({ length: 9 }, (_, id) => stream(id + 1))
    idle.forEach(grow)
    advance(BROWSER_NETWORK_TUNNEL_IDLE_STREAM_MS)
    const fresh = Array.from({ length: 9 }, (_, id) => stream(id + 100))
    fresh.forEach(grow)
    expect(fresh.every((s) => s.receiveWindowBytes === 2 * MIB)).toBe(true)

    // The first idle stream wakes: it is charged again past the pool and gives growth back.
    const woken = idle[0]!
    credit.receive(woken.id, LEGACY)
    expect(credit.replenishReceiveWindow(woken, LEGACY, false)).toBe(-LEGACY)
    expect(woken.receiveWindowBytes).toBe(2 * MIB - LEGACY)
  })

  it('returns a retired stream growth once, however often it is forgotten', () => {
    const { credit, stream, grow } = setup()
    const streams = Array.from({ length: 9 }, (_, id) => stream(id + 1))
    streams.forEach(grow)
    credit.forget(streams[0]!)
    credit.forget(streams[0]!)

    const fresh = stream(100)
    grow(fresh)
    expect(fresh.receiveWindowBytes).toBe(2 * MIB)
    const next = stream(101)
    credit.receive(next.id, LEGACY)
    expect(credit.replenishReceiveWindow(next, LEGACY, true)).toBe(POOL - 9 * (2 * MIB - LEGACY))
  })
})
