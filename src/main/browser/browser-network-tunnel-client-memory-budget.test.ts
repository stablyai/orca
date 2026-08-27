import { once } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  BrowserNetworkTunnelOpcode,
  encodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelWindowUpdate
} from '../../shared/browser-network-tunnel-protocol'
import { BrowserNetworkTunnelClient } from './browser-network-tunnel-client'
import type { BrowserNetworkTunnelDuplex } from './browser-network-tunnel-duplex'
import {
  BrowserNetworkTunnelOutboundMemoryBudgetRegistry,
  type BrowserNetworkTunnelOutboundMemoryLease
} from './browser-network-tunnel-outbound-memory-budget'

const TUNNEL_GENERATION = 7

function frame(
  opcode: BrowserNetworkTunnelOpcode,
  payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
  streamId = 1
): Uint8Array {
  return encodeBrowserNetworkTunnelFrame({
    opcode,
    tunnelGeneration: TUNNEL_GENERATION,
    streamId,
    payload
  })
}

describe('BrowserNetworkTunnelClient aggregate memory', () => {
  it('shares application-write admission across routes on one browser host', async () => {
    const registry = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry({
      hostMaxBytes: 10,
      processMaxBytes: 100
    })
    const first = createClient(registry.acquire('host-a')!)
    const second = createClient(registry.acquire('host-a')!)
    const firstSocket = await open(first.client)
    const secondSocket = await open(second.client)
    firstSocket.on('error', () => undefined)
    secondSocket.on('error', () => undefined)

    firstSocket.write(Buffer.alloc(6), vi.fn())
    secondSocket.write(Buffer.alloc(5), vi.fn())

    expect(registry.evidence().retainedBytes).toBe(6)
    expect(secondSocket.destroyed).toBe(true)

    firstSocket.destroy()
    await vi.waitFor(() => expect(registry.evidence().retainedBytes).toBe(0))
    const replacement = await open(second.client, 2)
    replacement.on('error', () => undefined)
    replacement.write(Buffer.alloc(5), vi.fn())
    expect(registry.evidence().retainedBytes).toBe(5)

    first.client.close()
    second.client.close()
  })

  it('retains destination bytes until the browser-facing socket write settles', async () => {
    const registry = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry({
      hostMaxBytes: 10,
      processMaxBytes: 100
    })
    const route = createClient(registry.acquire('host-a')!)
    const socket = await open(route.client)
    socket.on('error', () => undefined)

    route.client.handleBinary(frame(BrowserNetworkTunnelOpcode.Data, new Uint8Array([1, 2, 3])))
    expect(registry.evidence().retainedBytes).toBe(3)

    const received = once(socket, 'data')
    await received
    expect(registry.evidence().retainedBytes).toBe(3)
    socket.settleRead(3)
    expect(registry.evidence().retainedBytes).toBe(0)
    route.client.close()
  })

  it('releases a source-write claim only after credited transport handoff', async () => {
    const registry = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry({
      hostMaxBytes: 10,
      processMaxBytes: 100
    })
    const route = createClient(registry.acquire('host-a')!)
    const socket = await open(route.client)
    socket.on('error', () => undefined)
    const settled = vi.fn()

    socket.write(Buffer.alloc(4), settled)
    expect(registry.evidence().retainedBytes).toBe(4)
    route.client.handleBinary(
      frame(BrowserNetworkTunnelOpcode.WindowUpdate, encodeBrowserNetworkTunnelWindowUpdate(4))
    )

    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce())
    expect(registry.evidence().retainedBytes).toBe(0)
    route.client.close()
  })
})

function createClient(
  outboundMemory: Pick<BrowserNetworkTunnelOutboundMemoryLease, 'claimApplicationBytes'>
): { client: BrowserNetworkTunnelClient } {
  return {
    client: new BrowserNetworkTunnelClient({
      tunnelGeneration: TUNNEL_GENERATION,
      sendBinary: () => true,
      outboundMemory
    })
  }
}

async function open(
  client: BrowserNetworkTunnelClient,
  streamId = 1
): Promise<BrowserNetworkTunnelDuplex> {
  const opening = client.open({ host: 'localhost', port: 8080 })
  client.handleBinary(frame(BrowserNetworkTunnelOpcode.Opened, new Uint8Array(), streamId))
  return opening
}
