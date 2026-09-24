import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import {
  bundle,
  dependencies,
  FakeLogicalClient,
  FakeRelaySession,
  host
} from './mobile-endpoint-supervisor-test-fakes'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

describe('mobile endpoint supervisor relay credential eligibility', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // Recovery reports whether it actually dialled, so an empty credential set schedules one
  // retry instead of re-entering recovery on every tick.
  it('does not spin when no relay credential is eligible', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('connected'))
    const setTimer = vi.fn(setTimeout)
    const deps = dependencies({
      openRelay,
      setTimer,
      readBundle: vi.fn(async () => ({
        ...bundle,
        current: { ...bundle.current, expiresAt: Date.now() - 1 }
      }))
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    supervisor.stop()

    expect(openRelay).not.toHaveBeenCalled()
    expect(setTimer).toHaveBeenCalledTimes(1)
  })
})
