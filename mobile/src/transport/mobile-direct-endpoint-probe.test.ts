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

  it('fails a whole dead LAN in seconds instead of holding the 12s bound', async () => {
    // Incident 2026-09-04: foregrounding on a dead LAN produced an instant 1006 and
    // the direct client's 500/1000/2000ms redials, while the probe sat on the
    // 'connecting' phase and held the supervisor mutex for the whole 12s bound.
    const clients: FakeClient[] = []
    const openDirect = vi.fn(() => {
      const client = new FakeClient('connecting')
      clients.push(client)
      setTimeout(() => client.publishState('reconnecting'), 20)
      return client
    })

    const probing = openAuthenticatedDirectEndpoint(host, openDirect, 12_000)
    await vi.advanceTimersByTimeAsync(20)
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(probing).resolves.toBeNull()

    expect(clients).toHaveLength(2)
    for (const client of clients) {
      expect(client.close).toHaveBeenCalledOnce()
    }
    // No 12s timer is left behind to fire into a settled probe.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rides out one access-point flap that the first redial recovers', async () => {
    // 'reconnecting' is published on any socket close, so a single RST on the first
    // dial must not book a direct failure and its 60s cooldown.
    const openDirect = vi.fn((endpoint: string) => {
      const client = new FakeClient('connecting')
      if (endpoint.includes('100.64.0.2')) {
        setTimeout(() => client.publishState('reconnecting'), 20)
        setTimeout(() => client.publishState('connected'), 600)
      }
      return client
    })

    const probing = openAuthenticatedDirectEndpoint(host, openDirect, 12_000)
    await vi.advanceTimersByTimeAsync(600)
    const result = await probing

    expect(result?.path).toBe('tailscale')
    expect(result?.client.close).not.toHaveBeenCalled()
  })

  it('extends the grace once when the redial reaches a handshake', async () => {
    // The redial fires at 500ms, but 'connected' waits on the Noise handshake and a
    // capability RPC, so real work needs more than one grace window.
    const openDirect = vi.fn((endpoint: string) => {
      const client = new FakeClient('connecting')
      if (endpoint.includes('100.64.0.2')) {
        setTimeout(() => client.publishState('reconnecting'), 20)
        setTimeout(() => client.publishState('handshaking'), 1_500)
        // Past the first grace window: only the re-arm keeps this probe alive.
        setTimeout(() => client.publishState('connected'), 3_000)
      }
      return client
    })

    const probing = openAuthenticatedDirectEndpoint(host, openDirect, 12_000)
    await vi.advanceTimersByTimeAsync(3_000)

    expect((await probing)?.path).toBe('tailscale')
  })

  it('fails a handshake that stalls, one grace after it started', async () => {
    const openDirect = vi.fn(() => {
      const client = new FakeClient('connecting')
      setTimeout(() => client.publishState('reconnecting'), 20)
      setTimeout(() => client.publishState('handshaking'), 1_500)
      // A restarted handshake must not buy a second extension.
      setTimeout(() => client.publishState('handshaking'), 2_500)
      return client
    })

    const probing = openAuthenticatedDirectEndpoint(host, openDirect, 12_000)
    await vi.advanceTimersByTimeAsync(3_499)
    let settled = false
    void probing.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(probing).resolves.toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives up at the grace window when the redial never lands', async () => {
    const openDirect = vi.fn(() => {
      const client = new FakeClient('connecting')
      setTimeout(() => client.publishState('reconnecting'), 20)
      return client
    })

    const probing = openAuthenticatedDirectEndpoint(host, openDirect, 12_000)
    await vi.advanceTimersByTimeAsync(2_019)
    let settled = false
    void probing.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(probing).resolves.toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
})
