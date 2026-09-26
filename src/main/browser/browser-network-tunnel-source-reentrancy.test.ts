import { describe, expect, it, vi } from 'vitest'
import {
  BrowserNetworkTunnelOpcode as Opcode,
  decodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelWindowUpdate
} from '../../shared/browser-network-tunnel-protocol'
import { BrowserNetworkTunnelClient } from './browser-network-tunnel-client'
import { BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES } from './browser-network-tunnel-stream-state'

const frame = (
  opcode: Opcode,
  payload: Uint8Array<ArrayBufferLike> = new Uint8Array()
): Uint8Array =>
  encodeBrowserNetworkTunnelFrame({ opcode, payload, streamId: 1, tunnelGeneration: 7 })
const credit = (bytes: number): Uint8Array =>
  frame(Opcode.WindowUpdate, encodeBrowserNetworkTunnelWindowUpdate(bytes))
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

async function openClient(
  onData: (bytes: number[], client: BrowserNetworkTunnelClient) => boolean
) {
  const releases: ReturnType<typeof vi.fn>[] = []
  let retained = 0
  const client = new BrowserNetworkTunnelClient({
    tunnelGeneration: 7,
    outboundMemory: {
      claimApplicationBytes: (bytes) => {
        retained += bytes
        const release = vi.fn(() => {
          retained -= bytes
        })
        releases.push(release)
        return release
      }
    },
    sendBinary: (bytes) => {
      const decoded = decodeBrowserNetworkTunnelFrame(bytes)!
      return decoded.opcode !== Opcode.Data || onData([...decoded.payload], client)
    }
  })
  const opening = client.open({ host: 'example.internal', port: 80 })
  client.handleBinary(frame(Opcode.Opened))
  const socket = await opening
  socket.on('error', () => {})
  return { client, socket, releases, retained: () => retained }
}

describe('browser tunnel synchronous source sends', () => {
  it.each([1, BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES])(
    'spends credit before synchronous replenishment with window %i',
    async (window) => {
      const sent: number[][] = []
      const harness = await openClient((bytes, client) => {
        sent.push(bytes)
        if (sent.length === 1) {
          client.handleBinary(credit(bytes.length))
        }
        return true
      })
      try {
        harness.client.handleBinary(credit(window))
        const settled = vi.fn()
        harness.socket.write(Buffer.from([8, 9]), settled)
        await tick()
        expect(sent).toEqual(window === 1 ? [[8], [9]] : [[8, 9]])
        expect(settled).toHaveBeenCalledExactlyOnceWith(null)
        expect(harness.retained()).toBe(0)
        expect(harness.releases[0]).toHaveBeenCalledOnce()
        expect(harness.socket.destroyed).toBe(false)
      } finally {
        harness.client.close()
      }
    }
  )

  it('drains repeated synchronous credit without recursive sends and preserves callback writes', async () => {
    const sent: number[] = []
    let depth = 0
    let maxDepth = 0
    const harness = await openClient((bytes, client) => {
      depth++
      maxDepth = Math.max(maxDepth, depth)
      if (depth > 2) {
        return false
      }
      sent.push(...bytes)
      client.handleBinary(credit(bytes.length))
      depth--
      return true
    })
    try {
      const first = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251))
      const settled = vi.fn()
      harness.socket.write(first, () => {
        settled()
        harness.socket.write(Buffer.from([252, 253]), settled)
      })
      harness.client.handleBinary(credit(1))
      await tick()
      expect(sent).toEqual([...first, 252, 253])
      expect(maxDepth).toBe(1)
      expect(settled).toHaveBeenCalledTimes(2)
      expect(harness.retained()).toBe(0)
      for (const release of harness.releases) {
        expect(release).toHaveBeenCalledOnce()
      }
    } finally {
      harness.client.close()
    }
  })

  it.each(
    ['error', 'close', 'refuse', 'throw', 'credit-then-refuse'].flatMap((action) =>
      [1, 2].map((window) => ({ action, window }))
    )
  )(
    'settles and releases once when send encounters $action with window $window',
    async ({ action, window }) => {
      const sent: number[][] = []
      const harness = await openClient((bytes, client) => {
        sent.push(bytes)
        if (action === 'error') {
          client.handleBinary(frame(Opcode.Error))
        }
        if (action === 'close') {
          client.close()
        }
        if (action === 'credit-then-refuse' && sent.length === 1) {
          client.handleBinary(credit(1))
        }
        if (action === 'throw') {
          throw new Error('transport failed')
        }
        return action !== 'refuse' && action !== 'credit-then-refuse'
      })
      try {
        const settled = vi.fn()
        harness.socket.write(Buffer.from([8, 9]), settled)
        harness.client.handleBinary(credit(window))
        await tick()
        expect(sent).toEqual(window === 1 ? [[8]] : [[8, 9]])
        expect(settled).toHaveBeenCalledExactlyOnceWith(expect.any(Error))
        expect(harness.retained()).toBe(0)
        expect(harness.releases[0]).toHaveBeenCalledOnce()
        expect(harness.socket.destroyed).toBe(true)
      } finally {
        harness.client.close()
      }
    }
  )

  it.each([1, 2])('settles a synchronous Close with window %i', async (window) => {
    const harness = await openClient((_bytes, client) => {
      client.handleBinary(frame(Opcode.Close))
      return true
    })
    try {
      harness.socket.resume()
      const settled = vi.fn()
      harness.socket.write(Buffer.from([8, 9]), settled)
      harness.client.handleBinary(credit(window))
      await tick()
      expect(settled).toHaveBeenCalledTimes(1)
      expect(harness.retained()).toBe(0)
      expect(harness.releases[0]).toHaveBeenCalledOnce()
      expect(harness.socket.destroyed).toBe(true)
    } finally {
      harness.client.close()
    }
  })
})
