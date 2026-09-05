import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from './rpc-client'
import { openAuthenticatedDirectEndpoint } from './mobile-direct-endpoint-probe'
import type { ConnectionState, HostProfile, RpcResponse } from './types'

class FakeClient implements RpcClient {
  readonly sendRequest = vi.fn(async (): Promise<RpcResponse> => ({
    id: 'rpc-1',
    ok: true,
    result: {},
    _meta: { runtimeId: 'runtime-1' }
  }))
  readonly subscribe = vi.fn(() => () => {})
  readonly updateTerminalSubscriptionViewport = vi.fn()
  readonly notifyForeground = vi.fn()
  readonly close = vi.fn(() => this.publishState('disconnected'))
  private readonly listeners = new Set<(state: ConnectionState) => void>()

  constructor(private state: ConnectionState) {}

  getState = () => this.state
  getReconnectAttempt = () => 0
  getLastConnectedAt = () => null
  onStateChange = (listener: (state: ConnectionState) => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publishState(state: ConnectionState): void {
    this.state = state
    for (const listener of this.listeners) {
      listener(state)
    }
  }
}

const host: HostProfile = {
  id: 'host-1',
  name: 'Blue Whale',
  endpoint: 'ws://192.168.1.10:6768',
  deviceToken: 'device-token',
  publicKeyB64: 'A'.repeat(44),
  lastConnected: 1,
  endpoints: [
    { id: 'lan', kind: 'lan', url: 'ws://192.168.1.10:6768' },
    { id: 'tailscale', kind: 'tailscale', url: 'ws://100.64.0.2:6768' }
  ]
}

describe('mobile direct endpoint probe', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('uses the first authenticated candidate without waiting for a stale primary', async () => {
    const clients = new Map<string, FakeClient>()
    const openDirect = vi.fn((endpoint: string) => {
      const client = new FakeClient('connecting')
      clients.set(endpoint, client)
      if (endpoint.includes('100.64.0.2')) {
        setTimeout(() => client.publishState('connected'), 100)
      }
      return client
    })

    const probing = openAuthenticatedDirectEndpoint(host, openDirect, 12_000)
    await vi.advanceTimersByTimeAsync(100)
    const result = await probing

    expect(result?.path).toBe('tailscale')
    expect(openDirect).toHaveBeenCalledTimes(2)
    expect(clients.get(host.endpoint)?.close).toHaveBeenCalledOnce()
    expect(result?.client.close).not.toHaveBeenCalled()
  })
})
