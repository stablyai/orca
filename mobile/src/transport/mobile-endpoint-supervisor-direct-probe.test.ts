import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'
import {
  dependencies,
  FakeRelaySession,
  FakeSession,
  host,
  relay
} from './mobile-endpoint-supervisor-test-fakes'

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
    const initialRelay = new FakeSession('connected')
    const logical = createStableLogicalRpcClient(initialRelay, 'relay')
    const direct = new FakeSession('connecting')
    const recoveredRelay = new FakeRelaySession('connected')
    const openRelay = vi.fn(() => recoveredRelay)
    const deps = dependencies({ openDirect: vi.fn(() => direct), openRelay })
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)
    await supervisor.start()

    // Model a dead LAN closing immediately into direct-client backoff.
    supervisor.setForeground(false)
    supervisor.setForeground(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.openDirect).toHaveBeenCalledOnce()
    direct.publishState('reconnecting')
    initialRelay.publishState('disconnected')

    // Release recovery after the redial grace window instead of waiting the probe’s full bound.
    await vi.advanceTimersByTimeAsync(1_999)
    expect(openRelay).not.toHaveBeenCalled()
    expect(logical.getGeneration()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(openRelay).toHaveBeenCalledOnce()
    expect(direct.close).toHaveBeenCalledOnce()
    expect(logical.getState()).toBe('connected')
    expect(logical.getActivePath()).toBe('relay')
    expect(logical.getGeneration()).toBe(2)
    await logical.sendRequest('host.getStatus')
    expect(recoveredRelay.sendRequest).toHaveBeenCalledWith('host.getStatus', undefined, undefined)
    expect(initialRelay.sendRequest).not.toHaveBeenCalled()
    expect(initialRelay.close).toHaveBeenCalledOnce()
    supervisor.stop()
    expect(vi.getTimerCount()).toBe(0)
    logical.close()
  })
})
