import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'
import {
  dependencies,
  FakeLogicalClient,
  FakeRelaySession,
  FakeSession,
  host,
  unreachableDirect
} from './mobile-endpoint-supervisor-test-fakes'

// A cell that authenticates and then answers the confirm for a different relay host
// — what a rehomed desktop produces. The session fails after the logical cutover.
function confirmRejectingRelaySession(logical: FakeLogicalClient): FakeRelaySession {
  const session = new FakeRelaySession('connected', new Error('relay resume confirmation missing'))
  session.whenResumeConfirmed = async () => {
    session.publishState('disconnected')
    logical.publishState('disconnected')
  }
  return session
}

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

  it('recovers the relay at once while the probe is still dialing direct', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    // A black-holed LAN endpoint: the dial sits unanswered for its whole 12s budget.
    const direct = new FakeSession('connecting')
    const openRelay = vi.fn(() => new FakeRelaySession('connected'))
    const deps = dependencies({ openDirect: vi.fn(() => direct), openRelay })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    await vi.advanceTimersByTimeAsync(15_000)
    expect(deps.openDirect).toHaveBeenCalledOnce()
    logical.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(0)

    // Why: the dial is a pure observation, so it no longer owns the operation
    // mutex — recovery does not wait out the probe's budget.
    expect(openRelay).toHaveBeenCalledOnce()
    expect(logical.getState()).toBe('connected')
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('backs off a dial whose resume confirm fails after the cutover', async () => {
    const recordMigration = vi.spyOn(MobileEndpointHysteresis.prototype, 'recordMigration')
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(() => confirmRejectingRelaySession(logical))
    // No LAN to race: this is about the relay cadence after a confirm failure.
    const deps = dependencies({
      openRelay,
      openDirect: unreachableDirect(),
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    // Two sockets per pass: a confirm mismatch reads as a stale cell assignment, so
    // the existing director fallback re-resolves and dials the authoritative target.
    expect(openRelay).toHaveBeenCalledTimes(2)
    expect(logical.migrateTo).toHaveBeenCalledTimes(2)

    // Why: `connected` is published at authentication, so the cutover happens before
    // the confirm answers. A confirm that then fails must still book the shared
    // cooldown — reporting it as an established dial redials in a tight loop.
    await vi.advanceTimersByTimeAsync(0)
    expect(openRelay).toHaveBeenCalledTimes(2)

    // 250ms, then 500ms, then 1000ms: the streak grows instead of resetting, which
    // it could not do if setActiveSession had run for this dying session.
    await vi.advanceTimersByTimeAsync(249)
    expect(openRelay).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(openRelay).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(250)
    expect(openRelay).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(250)
    expect(openRelay).toHaveBeenCalledTimes(6)
    await vi.advanceTimersByTimeAsync(999)
    expect(openRelay).toHaveBeenCalledTimes(6)
    await vi.advanceTimersByTimeAsync(1)
    expect(openRelay).toHaveBeenCalledTimes(8)

    // No session whose confirm failed is ever booked as a migration.
    expect(recordMigration).not.toHaveBeenCalled()
    supervisor.stop()
  })

  it('replays a relay recovery that landed while the direct cutover owned the mutex', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const openRelay = vi.fn(() => new FakeRelaySession('connected'))
    const deps = dependencies({ openDirect: vi.fn(() => new FakeSession('connected')), openRelay })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    let release!: () => void
    const cutover = new Promise<void>((resolve) => {
      release = resolve
    })
    // The candidate loses the cutover, so the logical client stays on the relay path.
    logical.migrateTo.mockImplementationOnce(async (candidate) => {
      await cutover
      candidate.close()
    })
    // Three authenticated probes plus the observation and dwell windows.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(logical.migrateTo).toHaveBeenCalledOnce()

    logical.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(0)
    expect(openRelay).not.toHaveBeenCalled()

    release()
    await vi.advanceTimersByTimeAsync(0)

    // The queued request is replayed by afterProbe, never dropped.
    expect(openRelay).toHaveBeenCalledOnce()
    expect(logical.getState()).toBe('connected')
    supervisor.stop()
  })
})
