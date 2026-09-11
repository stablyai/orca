import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { BrowserNetworkTunnelClient } from './browser-network-tunnel-client'
import type { BrowserNetworkTunnelDuplex } from './browser-network-tunnel-duplex'
import { BrowserNetworkTunnelSession } from './browser-network-tunnel-session'
import type { BrowserNetworkTunnelSocket } from './browser-network-tunnel-stream-state'

class PairedSocket extends EventEmitter implements BrowserNetworkTunnelSocket {
  destroyed = false

  setNoDelay(): this {
    return this
  }

  pause(): this {
    return this
  }

  resume(): this {
    return this
  }

  write(_bytes: Uint8Array<ArrayBufferLike>, callback?: () => void): boolean {
    callback?.()
    return true
  }

  end(): this {
    return this
  }

  destroy(): this {
    this.destroyed = true
    return this
  }
}

type PairedTunnel = {
  session: BrowserNetworkTunnelSession
  client: BrowserNetworkTunnelClient
  sockets: PairedSocket[]
  closures: Error[]
  onSessionClose: ReturnType<typeof vi.fn>
}

// Both peers are real so a per-stream failure can be told apart from a tunnel-wide teardown.
function createPairedTunnel(
  claimAggregateRetainedBytes?: (bytes: number) => (() => void) | null
): PairedTunnel {
  const sockets: PairedSocket[] = []
  const closures: Error[] = []
  const onSessionClose = vi.fn()
  let client: BrowserNetworkTunnelClient | undefined
  const session = new BrowserNetworkTunnelSession({
    tunnelGeneration: 7,
    connect: () => {
      const socket = new PairedSocket()
      sockets.push(socket)
      return socket
    },
    sendBinary: (bytes) => {
      client?.handleBinary(bytes)
      return true
    },
    onClose: onSessionClose,
    claimAggregateRetainedBytes
  })
  client = new BrowserNetworkTunnelClient({
    tunnelGeneration: 7,
    sendBinary: (bytes) => {
      session.handleBinary(bytes)
      return true
    },
    onClosed: (error) => closures.push(error)
  })
  return { session, client, sockets, closures, onSessionClose }
}

async function openConnectedStream(
  tunnel: PairedTunnel,
  host: string
): Promise<BrowserNetworkTunnelDuplex> {
  const opening = tunnel.client.open({ host, port: 443 })
  tunnel.sockets.at(-1)!.emit('connect')
  return opening
}

describe('BrowserNetworkTunnelSession stream-scoped failures', () => {
  it('fails only the pending stream when the destination closes before connecting', async () => {
    const tunnel = createPairedTunnel()
    const healthy = await openConnectedStream(tunnel, 'healthy.internal')

    const pending = tunnel.client.open({ host: 'never-connects.internal', port: 443 })
    tunnel.sockets[1]!.emit('close')

    await expect(pending).rejects.toThrow('destination_closed_before_connect')
    expect(tunnel.closures).toEqual([])
    expect(healthy.destroyed).toBe(false)
    expect(tunnel.sockets[0]!.destroyed).toBe(false)
  })

  it('fails only the pending stream when the destination ends before connecting', async () => {
    const tunnel = createPairedTunnel()
    const healthy = await openConnectedStream(tunnel, 'healthy.internal')

    const pending = tunnel.client.open({ host: 'never-connects.internal', port: 443 })
    tunnel.sockets[1]!.emit('end')

    await expect(pending).rejects.toThrow('destination_closed_before_connect')
    expect(tunnel.closures).toEqual([])
    expect(healthy.destroyed).toBe(false)
    expect(tunnel.sockets[0]!.destroyed).toBe(false)
  })

  it('fails only the receiving stream when destination bytes exhaust the retained budget', async () => {
    const tunnel = createPairedTunnel(() => null)
    const healthy = await openConnectedStream(tunnel, 'healthy.internal')
    const starved = await openConnectedStream(tunnel, 'starved.internal')

    tunnel.sockets[1]!.emit('data', new Uint8Array([1, 2, 3]))

    expect(starved.destroyed).toBe(true)
    expect(tunnel.onSessionClose).not.toHaveBeenCalled()
    expect(tunnel.closures).toEqual([])
    expect(healthy.destroyed).toBe(false)
    expect(tunnel.sockets[0]!.destroyed).toBe(false)
  })

  it('fails only the sending stream when a destination write exhausts the retained budget', async () => {
    const tunnel = createPairedTunnel(() => null)
    const healthy = await openConnectedStream(tunnel, 'healthy.internal')
    const starved = await openConnectedStream(tunnel, 'starved.internal')

    starved.write(new Uint8Array([1, 2, 3]))

    expect(starved.destroyed).toBe(true)
    expect(tunnel.onSessionClose).not.toHaveBeenCalled()
    expect(tunnel.closures).toEqual([])
    expect(healthy.destroyed).toBe(false)
    expect(tunnel.sockets[0]!.destroyed).toBe(false)
  })
})
