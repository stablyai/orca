import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dependencies,
  FakeLogicalClient,
  FakeSession,
  host,
  relay
} from './mobile-endpoint-supervisor-test-fakes'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

// A skipped (link-local) direct endpoint seeds the logical client already reconnecting.
async function startWithUndialableDirect(directUnavailable: boolean) {
  const logical = new FakeLogicalClient('reconnecting', 'lan')
  const openDirect = vi.fn(() => new FakeSession('reconnecting'))
  const deps = dependencies({ openDirect, directUnavailable })
  const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)
  await supervisor.start()
  await vi.advanceTimersByTimeAsync(0)
  return { logical, openDirect, deps, supervisor }
}

describe('mobile endpoint supervisor with an undialable direct endpoint', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-08T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('recovers over relay at once and never probes the direct endpoint', async () => {
    const { logical, openDirect, deps, supervisor } = await startWithUndialableDirect(true)

    expect(deps.openRelay).toHaveBeenCalledOnce()
    expect(logical.getActivePath()).toBe('relay')

    supervisor.nudge('network-change')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(openDirect).not.toHaveBeenCalled()
    supervisor.stop()
  })

  it('still probes a dialable direct endpoint from relay', async () => {
    const { logical, openDirect, supervisor } = await startWithUndialableDirect(false)

    expect(logical.getActivePath()).toBe('relay')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(openDirect).toHaveBeenCalled()
    supervisor.stop()
  })
})
