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

describe('mobile endpoint supervisor relay retry while the LAN dial hangs', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-08T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries a failed relay dial on its backoff while the LAN dial stays connecting', async () => {
    const logical = new FakeLogicalClient('connecting', 'lan')
    const failed = () => new FakeRelaySession('disconnected', new Error('relay connect failed'))
    // The director fallback redials once per failed attempt, so the first race spends two sessions.
    const openRelay = vi
      .fn()
      .mockImplementationOnce(failed)
      .mockImplementationOnce(failed)
      .mockImplementation(() => new FakeRelaySession('connected'))
    const deps = dependencies({ openRelay, randomBytes: () => new Uint8Array([255, 255]) })
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)
    await supervisor.start()

    // The LAN dial never leaves connecting (a black-holed address waits out its 12 s connect deadline).
    await vi.advanceTimersByTimeAsync(3_500)

    expect(logical.getActivePath()).toBe('relay')
    expect(logical.getState()).toBe('connected')
    supervisor.stop()
  })
})
