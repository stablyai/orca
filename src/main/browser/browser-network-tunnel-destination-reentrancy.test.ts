import { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import {
  BrowserNetworkTunnelOpcode as Opcode,
  decodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelOpen,
  encodeBrowserNetworkTunnelWindowUpdate
} from '../../shared/browser-network-tunnel-protocol'
import { BrowserNetworkTunnelSession } from './browser-network-tunnel-session'
import { BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES } from './browser-network-tunnel-stream-state'

const frame = (
  opcode: Opcode,
  payload: Uint8Array<ArrayBufferLike> = new Uint8Array()
): Uint8Array =>
  encodeBrowserNetworkTunnelFrame({ opcode, payload, streamId: 1, tunnelGeneration: 7 })
const credit = (bytes: number): Uint8Array =>
  frame(Opcode.WindowUpdate, encodeBrowserNetworkTunnelWindowUpdate(bytes))

function openSession(onData: (bytes: number[], session: BrowserNetworkTunnelSession) => boolean) {
  const socket = new Socket()
  const releases: ReturnType<typeof vi.fn>[] = []
  let retained = 0
  const session = new BrowserNetworkTunnelSession({
    tunnelGeneration: 7,
    connect: () => socket,
    claimAggregateRetainedBytes: (bytes) => {
      retained += bytes
      const release = vi.fn(() => {
        retained -= bytes
      })
      releases.push(release)
      return release
    },
    sendBinary: (bytes) => {
      const decoded = decodeBrowserNetworkTunnelFrame(bytes)!
      return decoded.opcode !== Opcode.Data || onData([...decoded.payload], session)
    }
  })
  session.handleBinary(
    frame(Opcode.Open, encodeBrowserNetworkTunnelOpen({ host: 'example.internal', port: 80 }))
  )
  socket.emit('connect')
  return { session, socket, releases, retained: () => retained }
}

describe('browser tunnel synchronous destination sends', () => {
  it.each([1, BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES])(
    'spends credit before synchronous replenishment with window %i',
    (window) => {
      const sent: number[][] = []
      const harness = openSession((bytes, session) => {
        sent.push(bytes)
        if (sent.length === 1) {
          session.handleBinary(credit(bytes.length))
        }
        return true
      })
      try {
        harness.session.handleBinary(credit(window))
        harness.socket.emit('data', Buffer.from([8, 9]))
        expect(sent).toEqual(window === 1 ? [[8], [9]] : [[8, 9]])
        expect(harness.retained()).toBe(0)
        expect(harness.releases[0]).toHaveBeenCalledOnce()
        expect(harness.socket.destroyed).toBe(false)
      } finally {
        harness.session.close()
      }
    }
  )

  it('drains synchronous credit and newly queued data in order without recursive sends', () => {
    const sent: number[] = []
    let depth = 0
    let maxDepth = 0
    const harness = openSession((bytes, session) => {
      depth++
      maxDepth = Math.max(maxDepth, depth)
      if (depth > 2) {
        return false
      }
      sent.push(...bytes)
      if (sent.length === 1) {
        harness.socket.emit('data', Buffer.from([252, 253]))
      }
      session.handleBinary(credit(bytes.length))
      depth--
      return true
    })
    try {
      const first = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251))
      harness.socket.emit('data', first)
      harness.session.handleBinary(credit(1))
      expect(sent).toEqual([...first, 252, 253])
      expect(maxDepth).toBe(1)
      expect(harness.retained()).toBe(0)
      for (const release of harness.releases) {
        expect(release).toHaveBeenCalledOnce()
      }
    } finally {
      harness.session.close()
    }
  })

  it.each(
    ['error', 'close', 'refuse', 'throw', 'credit-then-refuse'].flatMap((action) =>
      [1, 2].map((window) => ({ action, window }))
    )
  )('releases once when send encounters $action with window $window', ({ action, window }) => {
    const sent: number[][] = []
    const harness = openSession((bytes, session) => {
      sent.push(bytes)
      if (action === 'error') {
        session.handleBinary(frame(Opcode.Error))
      }
      if (action === 'close') {
        session.handleBinary(frame(Opcode.Close))
      }
      if (action === 'credit-then-refuse' && sent.length === 1) {
        session.handleBinary(credit(1))
      }
      if (action === 'throw') {
        throw new Error('transport failed')
      }
      return action !== 'refuse' && action !== 'credit-then-refuse'
    })
    try {
      harness.socket.emit('data', Buffer.from([8, 9]))
      harness.session.handleBinary(credit(window))
      expect(sent).toEqual(window === 1 ? [[8]] : [[8, 9]])
      expect(harness.retained()).toBe(0)
      expect(harness.releases[0]).toHaveBeenCalledOnce()
      expect(harness.socket.destroyed).toBe(true)
    } finally {
      harness.session.close()
    }
  })
})
