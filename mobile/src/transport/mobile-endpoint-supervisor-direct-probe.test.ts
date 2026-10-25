import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import {
  dependencies,
  FakeLogicalClient,
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
    const logical = new FakeLogicalClient('connected', 'relay')
    const direct = new FakeSession('connecting')
    const openRelay = vi.fn(() => new FakeRelaySession('connected'))
    const deps = dependencies({ openDirect: vi.fn(() => direct), openRelay })
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)
    await supervisor.start()

    // Model a dead LAN closing immediately into direct-client backoff.
    supervisor.setForeground(false)
    supervisor.setForeground(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.openDirect).toHaveBeenCalledOnce()
    direct.publishState('reconnecting')
    logical.publishState('disconnected')

    // Release recovery after the redial grace window instead of waiting the probe’s full bound.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(openRelay).toHaveBeenCalledOnce()
    expect(direct.close).toHaveBeenCalled()
    expect(logical.getState()).toBe('connected')
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })
})
