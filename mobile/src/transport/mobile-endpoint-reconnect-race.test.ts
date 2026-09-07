import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import {
  dependencies,
  FakeLogicalClient,
  FakeRelaySession,
  FakeSession,
  host,
  unreachableDirect
} from './mobile-endpoint-supervisor-test-fakes'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

// Holds the relay cutover open so the direct path can authenticate mid-dial. The
// fake's migrateTo otherwise settles inside the dial, which no real cell does.
function holdRelayCutover(logical: FakeLogicalClient): () => void {
  const settle = logical.migrateTo.getMockImplementation()!
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  logical.migrateTo.mockImplementationOnce(async (session, path, timeoutMs, shouldAbort) => {
    await held
    // Why: replays the real post-authentication checks, so a superseded dial
    // still withdraws instead of stealing the client from the winner.
    return await settle(session, path, timeoutMs, shouldAbort)
  })
  return release
}

// One full lost race: the relay dial starts, direct returns mid-cutover and wins.
async function loseOneRace(
  logical: FakeLogicalClient,
  openRelay: ReturnType<typeof vi.fn>
): Promise<void> {
  const before = openRelay.mock.calls.length
  const release = holdRelayCutover(logical)
  logical.publishState('reconnecting')
  await vi.advanceTimersByTimeAsync(0)
  expect(openRelay.mock.calls.length).toBe(before + 1)
  logical.publishState('connected')
  release()
  await vi.advanceTimersByTimeAsync(0)
}

function relaySessionsFrom(openRelay: ReturnType<typeof vi.fn>): FakeRelaySession[] {
  return openRelay.mock.results.map((result) => result.value as FakeRelaySession)
}

describe('mobile endpoint reconnect race', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('dials relay at t=0 while the direct dial is still connecting', async () => {
    const logical = new FakeLogicalClient('connecting', 'lan')
    const deps = dependencies({ openDirect: unreachableDirect() })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    // No timer advance at all: an unfinished direct dial buys no head start.
    await supervisor.start()

    expect(deps.openRelay).toHaveBeenCalledOnce()
    expect(logical.getActivePath()).toBe('relay')
    expect(logical.migrateTo).toHaveBeenCalledWith(
      expect.any(FakeRelaySession),
      'relay',
      undefined,
      expect.any(Function)
    )
    supervisor.stop()
  })

  it('adopts the direct dial and withdraws the slower relay dial without booking it', async () => {
    const logical = new FakeLogicalClient('connecting', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('connected'))
    const deps = dependencies({ openRelay, openDirect: unreachableDirect() })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    const release = holdRelayCutover(logical)
    const starting = supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(openRelay).toHaveBeenCalledOnce()

    // The direct dial authenticates while the cell is still cutting over.
    logical.publishState('connected')
    release()
    await starting

    expect(logical.getActivePath()).toBe('lan')
    expect(relaySessionsFrom(openRelay)[0]!.close).toHaveBeenCalled()
    // A withdrawn dial is not a failure: no cooldown is armed, so no redial lands.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(openRelay).toHaveBeenCalledOnce()
    expect(logical.setRecoveryPath).toHaveBeenLastCalledWith(null)
    supervisor.stop()
  })

  it('adopts a direct socket that wins a reconnect the relay path started', async () => {
    const recordMigration = vi.spyOn(MobileEndpointHysteresis.prototype, 'recordMigration')
    const logical = new FakeLogicalClient('connected', 'relay')
    const openRelay = vi.fn(() => new FakeRelaySession('connected'))
    const deps = dependencies({ openRelay })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    const release = holdRelayCutover(logical)
    logical.publishState('disconnected')
    // The direct dial runs while the relay dial is still in flight and wins it.
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.openDirect).toHaveBeenCalledOnce()
    expect(logical.getActivePath()).toBe('lan')

    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(relaySessionsFrom(openRelay)[0]!.close).toHaveBeenCalled()
    // Hysteresis stamps the dwell, and the losing relay dial books no backoff.
    expect(recordMigration).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(openRelay).toHaveBeenCalledOnce()
    supervisor.stop()
  })

  it('books one backoff, not two, when both paths lose the reconnect', async () => {
    const recordDirectFailure = vi.spyOn(MobileEndpointHysteresis.prototype, 'recordDirectFailure')
    const logical = new FakeLogicalClient('connected', 'relay')
    const openRelay = vi.fn(() => new FakeRelaySession('disconnected', new RelayOuterError(4408)))
    const deps = dependencies({
      openRelay,
      openDirect: unreachableDirect(),
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    logical.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(0)
    expect(openRelay).toHaveBeenCalledOnce()
    expect(deps.openDirect).toHaveBeenCalledOnce()
    expect(recordDirectFailure).toHaveBeenCalledOnce()

    // One failure, so one 250ms step. A double-booked loss would redial at 500ms.
    await vi.advanceTimersByTimeAsync(249)
    expect(openRelay).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(openRelay).toHaveBeenCalledTimes(2)
    supervisor.stop()
  })

  it('leaves the promotion streak alone when the direct socket loses the race', async () => {
    const recordDirectSuccess = vi.spyOn(MobileEndpointHysteresis.prototype, 'recordDirectSuccess')
    const logical = new FakeLogicalClient('connected', 'relay')
    const direct = new FakeSession('connecting')
    const openRelay = vi.fn(() => new FakeRelaySession('connected'))
    const deps = dependencies({ openRelay, openDirect: vi.fn(() => direct) })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    const release = holdRelayCutover(logical)
    logical.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.openDirect).toHaveBeenCalledOnce()

    // Relay authenticates first, then the direct socket finally answers.
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(logical.getActivePath()).toBe('relay')
    direct.publishState('connected')
    await vi.advanceTimersByTimeAsync(0)

    expect(direct.close).toHaveBeenCalled()
    expect(recordDirectSuccess).not.toHaveBeenCalled()
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('ignores a loser that closes after the winner has been adopted', async () => {
    const logical = new FakeLogicalClient('connecting', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('connected'))
    const deps = dependencies({ openRelay, openDirect: unreachableDirect() })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    const release = holdRelayCutover(logical)
    const starting = supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    logical.publishState('connected')
    release()
    await starting
    expect(logical.getActivePath()).toBe('lan')

    // The withdrawn cell socket reports its close afterwards.
    relaySessionsFrom(openRelay)[0]!.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(logical.getState()).toBe('connected')
    expect(logical.getActivePath()).toBe('lan')
    expect(openRelay).toHaveBeenCalledOnce()
    supervisor.stop()
  })

  it('withdraws the relay socket before it authenticates once direct wins', async () => {
    const logical = new FakeLogicalClient('connecting', 'lan')
    const relaySession = new FakeRelaySession('connecting')
    const openRelay = vi.fn(() => relaySession)
    const deps = dependencies({ openRelay, openDirect: unreachableDirect() })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    const release = holdRelayCutover(logical)
    const starting = supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(openRelay).toHaveBeenCalledOnce()
    expect(relaySession.close).not.toHaveBeenCalled()

    // The direct dial authenticates while the cell socket is still pre-handshake.
    // migrateTo would not withdraw until after E2EE auth, so the cell would have
    // reserved a splice and the desktop would have finished a handshake for it.
    logical.publishState('connected')
    expect(relaySession.close).toHaveBeenCalled()
    expect(relaySession.getState()).not.toBe('connected')

    release()
    await starting
    await vi.advanceTimersByTimeAsync(60_000)
    expect(logical.getActivePath()).toBe('lan')
    expect(openRelay).toHaveBeenCalledOnce()
    supervisor.stop()
  })

  it('damps the race after a loss so a flapping LAN opens one cell socket', async () => {
    const logical = new FakeLogicalClient('connecting', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('connecting'))
    const deps = dependencies({ openRelay, openDirect: unreachableDirect() })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    // The first blip races, and the returning direct dial wins it.
    const release = holdRelayCutover(logical)
    const starting = supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    logical.publishState('connected')
    release()
    await starting
    expect(openRelay).toHaveBeenCalledOnce()

    // Two more blips inside the damper window open no further cell socket.
    for (const _blip of [1, 2]) {
      logical.publishState('reconnecting')
      await vi.advanceTimersByTimeAsync(100)
      logical.publishState('connected')
      await vi.advanceTimersByTimeAsync(400)
    }
    expect(openRelay).toHaveBeenCalledOnce()

    // The window lapses against a live direct path, so it still opens nothing.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(openRelay).toHaveBeenCalledOnce()
    supervisor.stop()
  })

  it('races at once when the LAN dies inside a damper window grown to the cap', async () => {
    const logical = new FakeLogicalClient('connecting', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('connecting'))
    const deps = dependencies({ openRelay, openDirect: unreachableDirect() })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    const release = holdRelayCutover(logical)
    const starting = supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    logical.publishState('connected')
    release()
    await starting

    // Four more losses, each once its window has run: 2s, 4s, 8s, 16s, then the
    // fifth earns the 30s cap.
    for (const window of [2_000, 4_000, 8_000, 16_000]) {
      await vi.advanceTimersByTimeAsync(window)
      await loseOneRace(logical, openRelay)
    }
    expect(openRelay).toHaveBeenCalledTimes(5)

    // This time direct does not come back. Waiting out the window a blip earned
    // would strand the phone offline for 30s with nothing else scheduled.
    logical.publishState('reconnecting')
    await vi.advanceTimersByTimeAsync(249)
    expect(openRelay).toHaveBeenCalledTimes(5)
    await vi.advanceTimersByTimeAsync(1)
    expect(openRelay.mock.calls.length).toBeGreaterThan(5)
    supervisor.stop()
  })

  it('lets a foreground resume race immediately inside a damper window', async () => {
    const logical = new FakeLogicalClient('connecting', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('connecting'))
    const deps = dependencies({ openRelay, openDirect: unreachableDirect() })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    const release = holdRelayCutover(logical)
    const starting = supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    logical.publishState('connected')
    release()
    await starting

    logical.publishState('reconnecting')
    await vi.advanceTimersByTimeAsync(100)
    expect(openRelay).toHaveBeenCalledOnce()

    // A resume is the user waiting on the screen; it never serves out the window.
    supervisor.setForeground(false)
    supervisor.setForeground(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(openRelay.mock.calls.length).toBeGreaterThan(1)
    supervisor.stop()
  })

  it('starts no dial in the background and races both paths on resume', async () => {
    const logical = new FakeLogicalClient('connecting', 'lan')
    const deps = dependencies({ openDirect: unreachableDirect() })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    supervisor.setForeground(false)
    await supervisor.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(deps.openRelay).not.toHaveBeenCalled()

    supervisor.setForeground(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(deps.openRelay).toHaveBeenCalledOnce()
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('runs the resume probe against a relay that survived the background grace', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    supervisor.setForeground(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(deps.openDirect).not.toHaveBeenCalled()

    // A live relay is not a reconnect: the resume probe dials direct, but the
    // promotion still has to earn its hysteresis streak.
    supervisor.setForeground(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.openDirect).toHaveBeenCalledOnce()
    expect(logical.getActivePath()).toBe('relay')
    expect(deps.openRelay).not.toHaveBeenCalled()
    supervisor.stop()
  })
})
