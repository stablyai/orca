import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { DIRECT_REFRESH_BUDGET_MS } from './mobile-direct-return-probe'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import {
  dependencies,
  FakeLogicalClient,
  FakeRelaySession,
  FakeSession,
  host,
  relay
} from './mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from './types'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

describe('mobile endpoint supervisor direct probe', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not block relay recovery behind a direct probe stuck in its redial loop', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const direct = new FakeSession('connecting')
    const openRelay = vi.fn(() => new FakeRelaySession('connected'))
    const deps = dependencies({ openDirect: vi.fn(() => direct), openRelay })
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)
    await supervisor.start()

    // Foreground return: the probe dials direct at once, the dead LAN answers with
    // an instant 1006, and the direct client enters its 500/1000/2000ms backoff.
    supervisor.setForeground(false)
    supervisor.setForeground(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.openDirect).toHaveBeenCalledOnce()
    direct.publishState('reconnecting')
    logical.publishState('disconnected')

    // Relay recovery must not wait out the probe's 12s bound; the probe gives up
    // one grace window after the redial fails to land.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(openRelay).toHaveBeenCalledOnce()
    expect(direct.close).toHaveBeenCalled()
    expect(logical.getState()).toBe('connected')
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('dials the saved endpoint when direct refresh exceeds the probe budget', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    let resolveRefresh: (response: RpcResponse) => void = () => {}
    logical.sendRequest.mockImplementation(
      () =>
        new Promise<RpcResponse>((resolve) => {
          resolveRefresh = resolve
        })
    )
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)
    await supervisor.start()

    await vi.advanceTimersByTimeAsync(15_000)
    expect(deps.openDirect).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(DIRECT_REFRESH_BUDGET_MS)
    expect(deps.openDirect).toHaveBeenCalledOnce()
    expect(deps.saveHost).not.toHaveBeenCalled()

    resolveRefresh({
      id: 'rpc-1',
      ok: true,
      result: {
        v: 1,
        selected: { kind: 'lan', url: 'ws://192.168.1.50:6768' },
        endpoints: [{ kind: 'lan', url: 'ws://192.168.1.50:6768' }]
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    await vi.waitFor(() => expect(deps.saveHost).toHaveBeenCalledOnce())
    supervisor.stop()
  })

  it('does not save a direct refresh that resolves after stop', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    let resolveRefresh: (response: RpcResponse) => void = () => {}
    logical.sendRequest.mockImplementation(
      () =>
        new Promise<RpcResponse>((resolve) => {
          resolveRefresh = resolve
        })
    )
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)
    await supervisor.start()
    await vi.advanceTimersByTimeAsync(15_000)
    supervisor.stop()

    resolveRefresh({
      id: 'rpc-1',
      ok: true,
      result: {
        v: 1,
        selected: { kind: 'lan', url: 'ws://192.168.1.50:6768' },
        endpoints: [{ kind: 'lan', url: 'ws://192.168.1.50:6768' }]
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    await vi.advanceTimersByTimeAsync(DIRECT_REFRESH_BUDGET_MS)
    expect(deps.saveHost).not.toHaveBeenCalled()
    expect(deps.openDirect).not.toHaveBeenCalled()
  })

  it('migrates under the path of the endpoint dialed for that attempt', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const tailscale = 'ws://100.64.0.2:6768'
    let endpoint = host.endpoint
    logical.sendRequest.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: {
        v: 1,
        selected: { kind: 'tailscale', url: tailscale },
        endpoints: [{ kind: 'tailscale', url: tailscale }]
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    const deps = dependencies({
      directPath: () => (endpoint === tailscale ? 'tailscale' : 'lan'),
      openDirect: vi.fn(() => new FakeSession('connected')),
      saveHost: vi.fn(async (next) => {
        endpoint = next.endpoint
      })
    })
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)
    await supervisor.start()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(logical.getActivePath()).toBe('tailscale')
    expect(logical.migrateTo).toHaveBeenCalledWith(
      expect.any(FakeSession),
      'tailscale',
      undefined,
      expect.any(Function)
    )
    expect(deps.openDirect).toHaveBeenCalled()
    supervisor.stop()
  })
})
