import { expect, it, vi } from 'vitest'
import {
  dependencies,
  FakeLogicalClient,
  FakeSession,
  host
} from './mobile-endpoint-supervisor-test-fakes'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))
it('closes in-flight candidates and clears their timeout when the owner stops', async () => {
  vi.useFakeTimers()
  try {
    const candidate = new FakeSession('connecting')
    const logical = new FakeLogicalClient('connected', 'relay')
    const deps = dependencies({ openDirect: vi.fn(() => candidate) })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(deps.openDirect).toHaveBeenCalledOnce()
    supervisor.stop()
    await vi.advanceTimersByTimeAsync(0)
    expect(candidate.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(12_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(candidate.close).toHaveBeenCalledOnce()
    expect(logical.migrateTo).not.toHaveBeenCalled()
    expect(deps.openDirect).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})

it('closes an authenticated candidate when stop races its completion', async () => {
  vi.useFakeTimers()
  try {
    const candidate = new FakeSession('connecting')
    const logical = new FakeLogicalClient('connected', 'relay')
    const deps = dependencies({ openDirect: vi.fn(() => candidate) })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()
    await vi.advanceTimersByTimeAsync(15_000)
    candidate.publishState('connected')
    supervisor.stop()
    await vi.advanceTimersByTimeAsync(0)
    expect(candidate.close).toHaveBeenCalledOnce()
    expect(logical.migrateTo).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('preserves an in-flight probe across a transient background pause', async () => {
  vi.useFakeTimers()
  try {
    const candidate = new FakeSession('connecting')
    const logical = new FakeLogicalClient('connected', 'relay')
    const deps = dependencies({ openDirect: vi.fn(() => candidate) })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()
    await vi.advanceTimersByTimeAsync(15_000)
    supervisor.setForeground(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(candidate.close).not.toHaveBeenCalled()
    supervisor.stop()
    await vi.advanceTimersByTimeAsync(0)
    expect(candidate.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('releases every candidate when multiple endpoint probes are pending', async () => {
  vi.useFakeTimers()
  try {
    const candidates: FakeSession[] = []
    const logical = new FakeLogicalClient('connected', 'relay')
    const deps = dependencies({
      openDirect: vi.fn(() => {
        const candidate = new FakeSession('connecting')
        candidates.push(candidate)
        return candidate
      })
    })
    const supervisor = new MobileEndpointSupervisor(
      logical,
      {
        ...host,
        endpoints: [{ id: 'alternate', kind: 'tailscale', url: 'ws://100.64.0.2:6768' }]
      },
      deps
    )
    await supervisor.start()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(candidates).toHaveLength(2)
    supervisor.stop()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
    for (const candidate of candidates) {
      expect(candidate.close).toHaveBeenCalledOnce()
      candidate.publishState('connected')
    }
    await vi.advanceTimersByTimeAsync(60_000)
    expect(logical.migrateTo).not.toHaveBeenCalled()
    expect(deps.openDirect).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})
