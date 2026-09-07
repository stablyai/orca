import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import {
  dependencies,
  FakeLogicalClient,
  FakeRelaySession,
  FakeSession,
  host
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
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
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
})
