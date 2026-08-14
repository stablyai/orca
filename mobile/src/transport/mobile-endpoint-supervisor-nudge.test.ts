import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import {
  bundle,
  dependencies,
  FakeLogicalClient,
  FakeRelaySession,
  FakeSession,
  host
} from './mobile-endpoint-supervisor-test-fakes'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import { MobileRelaySessionEstablisher } from './mobile-relay-session-establisher'
import type { RelayReconnectController } from './mobile-relay-reconnect-controller'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

// Focus/network nudge routing, make-before-break replacement, and the
// happy-eyeballs race — split from the main supervisor suite (max-lines).
describe('mobile endpoint supervisor nudges', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('replaces a relay make-before-break on a network nudge without going grey', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const deps = dependencies({
      openDirect: vi.fn(() => new FakeSession('disconnected'))
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    expect(deps.openRelay).toHaveBeenCalledOnce()
    expect(logical.getActivePath()).toBe('relay')

    // The OS reports a network handoff, but the relay never published onclose.
    // The replacement authenticates, migrateTo swaps sessions — never disconnected.
    supervisor.nudge('network-change')
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.openRelay).toHaveBeenCalledTimes(2)
    expect(logical.suspendActiveSession).not.toHaveBeenCalled()
    expect(logical.getState()).toBe('connected')
    supervisor.stop()
  })

  it('suspends only after a failed replacement dial, then backs off further nudges', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('connected'))
      .mockImplementation(() => new FakeRelaySession('disconnected', new RelayOuterError(4408)))
    const deps = dependencies({
      openRelay,
      // Keep direct unavailable so relay recovery stays the only path under test.
      openDirect: vi.fn(() => new FakeSession('disconnected')),
      // Deterministic full jitter: fraction 0.5 → half the backoff window.
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    expect(openRelay).toHaveBeenCalledOnce()

    // PEER_DROPPED on the replacement: the suspect session comes down so the
    // armed retry can run, and the failure books the shared cooldown.
    supervisor.nudge('network-change')
    await vi.advanceTimersByTimeAsync(0)
    expect(logical.suspendActiveSession).toHaveBeenCalledOnce()
    expect(openRelay).toHaveBeenCalledTimes(2)

    // More flap nudges share the existing cooldown rather than opening sockets.
    for (let i = 0; i < 5; i++) {
      supervisor.nudge('network-change')
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(openRelay).toHaveBeenCalledTimes(2)

    // Exactly one retry fires at the 250 ms deterministic backoff boundary.
    await vi.advanceTimersByTimeAsync(249)
    expect(openRelay).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(openRelay).toHaveBeenCalledTimes(3)
    supervisor.stop()
  })

  it('leaves physical relay probing to the session watchdog', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    supervisor.nudge('focus')
    await vi.advanceTimersByTimeAsync(0)
    expect(logical.sendRequest).not.toHaveBeenCalled()
    expect(logical.suspendActiveSession).not.toHaveBeenCalled()
    expect(deps.openRelay).not.toHaveBeenCalled()

    // Repeated focus events never create a second supervisor-owned liveness policy.
    supervisor.nudge('focus')
    await vi.advanceTimersByTimeAsync(0)
    expect(logical.sendRequest).not.toHaveBeenCalled()
    supervisor.stop()
  })

  it('does not suspend a relay from one focus RPC failure', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    supervisor.nudge('focus')
    await vi.advanceTimersByTimeAsync(0)
    expect(logical.suspendActiveSession).not.toHaveBeenCalled()
    expect(deps.openRelay).not.toHaveBeenCalled()
    expect(logical.getState()).toBe('connected')
    supervisor.stop()
  })

  it('queues a network replacement that lands while another dial owns the mutex', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    let resolveWrite: (() => void) | null = null
    const deps = dependencies({
      openDirect: vi.fn(() => new FakeSession('disconnected')),
      writeBundle: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              resolveWrite = resolve
            })
        )
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()
    expect(deps.openRelay).toHaveBeenCalledOnce()

    // First handoff nudge dials a replacement whose bookkeeping write is slow,
    // holding the recovery mutex; the second nudge arriving then must neither
    // suspend the session nor be dropped.
    supervisor.nudge('network-change')
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.openRelay).toHaveBeenCalledTimes(2)
    supervisor.nudge('network-change')
    expect(logical.suspendActiveSession).not.toHaveBeenCalled()

    resolveWrite?.()
    await vi.advanceTimersByTimeAsync(0)
    // The in-flight replacement satisfies the queued intent — no third socket.
    expect(deps.openRelay).toHaveBeenCalledTimes(2)
    expect(logical.getState()).toBe('connected')
    supervisor.stop()
  })

  it('keeps a healthy relay bound when a nudge finds no dialable credential', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const expired = {
      ...bundle,
      current: { ...bundle.current, expiresAt: 1 }
    }
    const deps = dependencies({
      readBundle: vi.fn(async () => expired),
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    supervisor.nudge('network-change')
    await vi.advanceTimersByTimeAsync(0)
    // Why: no dial happened, so nothing has disproven the live session.
    expect(logical.suspendActiveSession).not.toHaveBeenCalled()
    expect(deps.openRelay).not.toHaveBeenCalled()
    expect(logical.getState()).toBe('connected')
    supervisor.stop()
  })

  it('withdraws the racing relay dial when direct authenticated while it was in flight', async () => {
    // Direct won between the grace timer firing and the relay session
    // authenticating; the migration must withdraw instead of closing the winner.
    const logical = new FakeLogicalClient('connected', 'lan')
    const relaySession = new FakeRelaySession('connected')
    const setActiveSession = vi.fn()
    const establisher = new MobileRelaySessionEstablisher({
      logical,
      controller: { setActiveSession } as unknown as RelayReconnectController,
      openRelay: vi.fn(() => relaySession),
      randomBytes: (length) => new Uint8Array(length),
      writeBundle: vi.fn(async () => {}),
      isActive: () => true,
      isForeground: () => true,
      relay: () => host.relay,
      resolveRelay: vi.fn(async ({ relay: endpoint }) => endpoint),
      persistResolvedRelay: vi.fn(async () => {}),
      bundle: () => bundle,
      adoptBundle: vi.fn(),
      recordMigration: vi.fn(),
      scheduleLease: vi.fn(),
      scheduleDirectProbe: vi.fn(),
      onBookkeepingError: vi.fn(),
      onDialFailure: vi.fn()
    })

    const outcome = await establisher.dialEligible([bundle.current])
    expect(outcome).toEqual({ outcome: 'aborted' })
    expect(setActiveSession).not.toHaveBeenCalled()
    expect(relaySession.close).toHaveBeenCalled()
    expect(logical.getActivePath()).toBe('lan')
  })
})
