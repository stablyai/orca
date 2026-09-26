import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from './rpc-client'
import {
  directPathForEndpoint,
  openAuthenticatedDirectEndpoint
} from './mobile-direct-endpoint-probe'
import type { ConnectionState, RpcResponse } from './types'

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

describe('mobile direct endpoint probe', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('classifies a tailnet endpoint apart from a LAN one', () => {
    expect(directPathForEndpoint('ws://100.64.0.2:6768')).toBe('tailscale')
    expect(directPathForEndpoint('wss://desk.tail1234.ts.net:6768')).toBe('tailscale')
    expect(directPathForEndpoint('ws://[fd7a:115c:a1e0::1]:6768')).toBe('tailscale')
    // 100.0.0.0/10 is not the tailnet's 100.64.0.0/10.
    expect(directPathForEndpoint('ws://100.12.0.2:6768')).toBe('lan')
    expect(directPathForEndpoint('ws://192.168.1.10:6768')).toBe('lan')
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

    const probing = openAuthenticatedDirectEndpoint(openDirect, 12_000)
    await vi.advanceTimersByTimeAsync(20)
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(probing).resolves.toBeNull()

    expect(clients).toHaveLength(1)
    expect(clients[0]!.close).toHaveBeenCalledOnce()
    // No 12s timer is left behind to fire into a settled probe.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rides out one access-point flap that the first redial recovers', async () => {
    // 'reconnecting' is published on any socket close, so a single RST on the first
    // dial must not book a direct failure and its 60s cooldown.
    const openDirect = vi.fn(() => {
      const client = new FakeClient('connecting')
      setTimeout(() => client.publishState('reconnecting'), 20)
      setTimeout(() => client.publishState('connected'), 600)
      return client
    })

    const probing = openAuthenticatedDirectEndpoint(openDirect, 12_000)
    await vi.advanceTimersByTimeAsync(600)
    const result = await probing

    expect(result).not.toBeNull()
    expect(result?.close).not.toHaveBeenCalled()
  })

  it('extends the grace once when the redial reaches a handshake', async () => {
    // The redial fires at 500ms, but 'connected' waits on the Noise handshake and a
    // capability RPC, so real work needs more than one grace window.
    const openDirect = vi.fn(() => {
      const client = new FakeClient('connecting')
      setTimeout(() => client.publishState('reconnecting'), 20)
      setTimeout(() => client.publishState('handshaking'), 1_500)
      // Past the first grace window: only the re-arm keeps this probe alive.
      setTimeout(() => client.publishState('connected'), 3_000)
      return client
    })

    const probing = openAuthenticatedDirectEndpoint(openDirect, 12_000)
    await vi.advanceTimersByTimeAsync(3_000)

    expect(await probing).not.toBeNull()
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

    const probing = openAuthenticatedDirectEndpoint(openDirect, 12_000)
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

    const probing = openAuthenticatedDirectEndpoint(openDirect, 12_000)
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
