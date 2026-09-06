import { expect, it, vi } from 'vitest'
import {
  dependencies,
  FakeLogicalClient,
  FakeSession,
  host
} from './mobile-endpoint-supervisor-test-fakes'
import { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'
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
    vi.restoreAllMocks()
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
    vi.restoreAllMocks()
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
    vi.restoreAllMocks()
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
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})

it.each([false, true])(
  'fences migration finishing after stop (already swapped: %s)',
  async (alreadySwapped) => {
    vi.useFakeTimers()
    try {
      const recordedMigration = vi.spyOn(MobileEndpointHysteresis.prototype, 'recordMigration')
      const relay = new FakeSession('connected')
      const logical = createStableLogicalRpcClient(relay, 'relay')
      const candidates: FakeSession[] = []
      const deps = dependencies({
        openDirect: vi.fn(() => {
          const candidate = new FakeSession('connected')
          candidates.push(candidate)
          return candidate
        })
      })
      const supervisor = new MobileEndpointSupervisor(logical, host, deps)
      const migrate = logical.migrateTo.bind(logical)
      let release!: () => void
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      const migration = vi.spyOn(logical, 'migrateTo').mockImplementation(async (...args) => {
        if (alreadySwapped) {
          await migrate(...args)
        }
        await pending
        if (!alreadySwapped) {
          await migrate(...args)
        }
      })
      await supervisor.start()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(migration).toHaveBeenCalledOnce()
      const requestsBeforeStop = relay.sendRequest.mock.calls.length
      const candidateRequestsBeforeStop = candidates[3].sendRequest.mock.calls.length
      const migrationsBeforeStop = recordedMigration.mock.calls.length
      supervisor.stop()
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(logical.getActivePath()).toBe(alreadySwapped ? 'lan' : 'relay')
      expect(logical.getGeneration()).toBe(alreadySwapped ? 2 : 1)
      expect(relay.sendRequest).toHaveBeenCalledTimes(requestsBeforeStop)
      expect(candidates[3].sendRequest).toHaveBeenCalledTimes(candidateRequestsBeforeStop)
      expect(recordedMigration).toHaveBeenCalledTimes(migrationsBeforeStop)
      expect(candidates[3].close).toHaveBeenCalledTimes(alreadySwapped ? 0 : 1)
      expect(vi.getTimerCount()).toBe(0)
      logical.close()
    } finally {
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
  }
)
