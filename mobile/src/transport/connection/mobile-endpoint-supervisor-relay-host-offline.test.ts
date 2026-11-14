import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dependencies,
  FakeLogicalClient,
  FakeRelaySession,
  host,
  relay
} from './mobile-endpoint-supervisor-test-fakes'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import { RelayOuterError } from '../encryption/mobile-relay-e2ee-link'
import { RelayDirectorResolveTimeoutError } from '../relay/mobile-relay-resume-director'
import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'
import type { ConnectionLogEntry } from '../../diagnostics/connection/connection-log-types'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

const hostOfflineSession = () =>
  new FakeRelaySession('disconnected', new RelayOuterError(4404, false, ''))

async function startOffLan(overrides: Partial<MobileEndpointSupervisorDependencies>) {
  const logical = new FakeLogicalClient('disconnected', 'lan')
  const logs: ConnectionLogEntry[] = []
  const deps = dependencies({
    openRelay: vi.fn(hostOfflineSession),
    onLog: (entry) => logs.push(entry),
    // Full-width jitter: 4404 retries wait the full 15s.
    randomBytes: () => new Uint8Array([255, 255]),
    ...overrides
  })
  const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)
  await supervisor.start()
  await vi.advanceTimersByTimeAsync(0)
  return { logical, deps, logs, supervisor }
}

describe('mobile endpoint supervisor on persistent host-offline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-13T12:00:00Z'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('asks the director on the second 4404 and adopts the cell it names', async () => {
    const moved = { ...relay, cellUrl: 'https://relay-hk.onorca.dev' }
    const openRelay = vi
      .fn()
      .mockImplementationOnce(hostOfflineSession)
      .mockImplementationOnce(hostOfflineSession)
      .mockImplementation(() => new FakeRelaySession('connected'))
    const resolveRelay = vi.fn(async () => moved)
    const { logical, deps, supervisor } = await startOffLan({ openRelay, resolveRelay })
    expect(openRelay).toHaveBeenCalledTimes(1)
    expect(resolveRelay).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(15_000)
    expect(resolveRelay).toHaveBeenCalledOnce()
    expect(resolveRelay).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 5_000 }))
    expect(deps.setRelayRouting).toHaveBeenCalledWith(host.id, moved)
    expect(openRelay).toHaveBeenLastCalledWith(
      moved,
      expect.anything(),
      expect.any(String),
      expect.any(Function)
    )
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('gives the next resolve 10s after one times out', async () => {
    const resolveRelay = vi.fn(async (_input: { timeoutMs?: number }) => {
      throw new RelayDirectorResolveTimeoutError(5_000)
    })
    const { supervisor } = await startOffLan({ resolveRelay })
    // Resolves are at least 5 minutes apart within an offline episode.
    await vi.advanceTimersByTimeAsync(12 * 60_000)
    const budgets = resolveRelay.mock.calls.map(([input]) => input.timeoutMs)
    expect(budgets.length).toBeGreaterThanOrEqual(2)
    expect(budgets[0]).toBe(5_000)
    expect(budgets.slice(1).every((timeoutMs) => timeoutMs === 10_000)).toBe(true)
    supervisor.stop()
  })

  it('asks the director only a few times while a laptop sleeps for two hours', async () => {
    // The director keeps naming the same cell; the edge keeps answering 4404.
    const resolveRelay = vi.fn(async ({ relay: current }: { relay: typeof relay }) => current)
    const { deps, supervisor } = await startOffLan({ resolveRelay })
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    // Gaps of 5, 10, 20, 40 min: resolves near 0, 5, 15, 35 and 75 min.
    expect(resolveRelay.mock.calls.length).toBeGreaterThanOrEqual(5)
    expect(resolveRelay.mock.calls.length).toBeLessThanOrEqual(6)
    // Unchanged answers neither re-route nor add an immediate redial: 4404 pacing alone (5-15s).
    expect(deps.setRelayRouting).not.toHaveBeenCalled()
    expect(vi.mocked(deps.openRelay).mock.calls.length).toBeLessThanOrEqual(120 * 4 + 1)
    supervisor.stop()
  })

  it('logs cooldown deferrals with their remaining time, at most once per window', async () => {
    const { logical, logs, supervisor } = await startOffLan({})
    // An unroutable LAN address fails fast; each direct state flap re-enters relay recovery.
    for (let i = 0; i < 10; i++) {
      logical.publishState('reconnecting')
      logical.publishState('disconnected')
      await vi.advanceTimersByTimeAsync(1_000)
    }
    const deferrals = logs.filter((entry) => entry.message.startsWith('Relay: recovery deferred'))
    expect(deferrals).toHaveLength(1)
    expect(deferrals[0].message).toBe('Relay: recovery deferred by cooldown')
    expect(deferrals[0].detail).toMatch(/^retryInMs=\d+$/)
    supervisor.stop()
  })
})
