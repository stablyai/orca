import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dependencies,
  FakeLogicalClient,
  FakeRelaySession,
  host,
  relay
} from './mobile-endpoint-supervisor-test-fakes'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

// A network-change nudge abandons the stale LAN dial and redials at once.
function redialDirect(logical: FakeLogicalClient): void {
  logical.publishState('reconnecting')
  logical.publishState('connecting')
}

async function startOnLan(openRelay = vi.fn(() => new FakeRelaySession('connected'))) {
  const logical = new FakeLogicalClient('connected', 'lan')
  // Full-width jitter so the shared cooldown runs at its real cadence.
  const deps = dependencies({ openRelay, randomBytes: () => new Uint8Array([255, 255]) })
  const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)
  await supervisor.start()
  await vi.advanceTimersByTimeAsync(0)
  return { logical, openRelay, supervisor }
}

describe('mobile endpoint supervisor relay race after a mid-session LAN loss', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-08T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('moves to relay while network-change redials keep the LAN dial connecting', async () => {
    const { logical, openRelay, supervisor } = await startOnLan()

    // Nudges every second never let the dial age out of connecting; the race fires 2.5 s into the outage.
    for (let i = 0; i < 3; i++) {
      redialDirect(logical)
      await vi.advanceTimersByTimeAsync(1_000)
    }

    expect(openRelay).toHaveBeenCalledOnce()
    expect(logical.getActivePath()).toBe('relay')
    expect(logical.getState()).toBe('connected')
    supervisor.stop()
  })

  it('drops a race deferred by cooldown once the LAN comes back', async () => {
    const { logical, openRelay, supervisor } = await startOnLan(
      vi.fn(() => new FakeRelaySession('connecting'))
    )
    for (let i = 0; i < 15; i++) {
      redialDirect(logical)
      await vi.advanceTimersByTimeAsync(2_000)
    }
    const dialsDuringOutage = openRelay.mock.calls.length

    logical.publishState('connected')
    supervisor.nudge('network-change')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(logical.getActivePath()).toBe('lan')
    expect(openRelay).toHaveBeenCalledTimes(dialsDuringOutage)
    supervisor.stop()
  })
})
