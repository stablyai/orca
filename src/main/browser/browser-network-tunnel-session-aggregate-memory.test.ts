import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  BrowserNetworkTunnelOpcode,
  encodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelOpen
} from '../../shared/browser-network-tunnel-protocol'
import { BrowserNetworkTunnelOutboundMemoryBudgetRegistry } from './browser-network-tunnel-outbound-memory-budget'
import { BrowserNetworkTunnelSession } from './browser-network-tunnel-session'
import type { BrowserNetworkTunnelSocket } from './browser-network-tunnel-stream-state'

class AggregateMemorySocket extends EventEmitter implements BrowserNetworkTunnelSocket {
  readonly writeCallbacks: (() => void)[] = []
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
    if (callback) {
      this.writeCallbacks.push(callback)
    }
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

describe('BrowserNetworkTunnelSession aggregate memory', () => {
  it('shares destination queue admission across routes for one browser host', () => {
    const registry = createRegistry()
    const first = createSession(registry.acquire('host-a')!.claimApplicationBytes)
    const second = createSession(registry.acquire('host-a')!.claimApplicationBytes)

    first.socket.emit('data', new Uint8Array(6))
    second.socket.emit('data', new Uint8Array(5))

    expect(registry.evidence().retainedBytes).toBe(6)
    expect(first.socket.destroyed).toBe(false)
    expect(second.socket.destroyed).toBe(true)

    first.session.close()
    expect(registry.evidence().retainedBytes).toBe(0)
  })

  it('shares unsettled destination writes and releases them exactly on route close', () => {
    const registry = createRegistry()
    const first = createSession(registry.acquire('host-a')!.claimApplicationBytes)
    const second = createSession(registry.acquire('host-a')!.claimApplicationBytes)

    first.session.handleBinary(frame(BrowserNetworkTunnelOpcode.Data, new Uint8Array(6)))
    second.session.handleBinary(frame(BrowserNetworkTunnelOpcode.Data, new Uint8Array(5)))

    expect(registry.evidence().retainedBytes).toBe(6)
    expect(second.socket.destroyed).toBe(true)
    first.session.close()
    first.socket.writeCallbacks[0]?.()
    expect(registry.evidence().retainedBytes).toBe(0)
  })
})

function createRegistry(): BrowserNetworkTunnelOutboundMemoryBudgetRegistry {
  return new BrowserNetworkTunnelOutboundMemoryBudgetRegistry({
    hostMaxBytes: 10,
    processMaxBytes: 100
  })
}

function createSession(claimAggregateRetainedBytes: (bytes: number) => (() => void) | null): {
  session: BrowserNetworkTunnelSession
  socket: AggregateMemorySocket
} {
  const socket = new AggregateMemorySocket()
  const session = new BrowserNetworkTunnelSession({
    tunnelGeneration: 7,
    connect: () => socket,
    sendBinary: () => true,
    claimAggregateRetainedBytes
  })
  session.handleBinary(
    frame(
      BrowserNetworkTunnelOpcode.Open,
      encodeBrowserNetworkTunnelOpen({ host: 'remote.internal', port: 443 })
    )
  )
  socket.emit('connect')
  return { session, socket }
}

function frame(
  opcode: BrowserNetworkTunnelOpcode,
  payload: Uint8Array<ArrayBufferLike>
): Uint8Array {
  return encodeBrowserNetworkTunnelFrame({ opcode, tunnelGeneration: 7, streamId: 1, payload })
}
