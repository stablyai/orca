import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import {
  bundle,
  dependencies,
  FakeLogicalClient,
  FakeRelaySession,
  FakeSession,
  host,
  relay
} from './mobile-endpoint-supervisor-test-fakes'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import { MobileRelaySessionEstablisher } from './mobile-relay-session-establisher'
import { RelayReconnectController } from './mobile-relay-reconnect-controller'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

describe('mobile endpoint supervisor nudges', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a healthy relay bound across repeated network hints', async () => {
    const logical = createStableLogicalRpcClient(new FakeSession('disconnected'), 'lan')
    const activeRelay = new FakeRelaySession('connected')
    const deps = dependencies({
      openRelay: vi.fn(() => activeRelay),
      openDirect: vi.fn(() => new FakeSession('disconnected'))
    })
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)
    await supervisor.start()
    const generation = logical.getGeneration()

    for (let index = 0; index < 3; index++) {
      supervisor.nudge('network-change')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(logical.getState()).toBe('connected')
      expect(logical.getGeneration()).toBe(generation)
      expect(deps.openRelay).toHaveBeenCalledOnce()
      expect(activeRelay.close).not.toHaveBeenCalled()
    }
    await logical.sendRequest('status.get')
    expect(activeRelay.sendRequest).toHaveBeenCalledWith('status.get', undefined, undefined)
    supervisor.stop()
    logical.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('restarts a disconnected Relay immediately on an app-resume retry', async () => {
    const logical = new FakeLogicalClient('disconnected', 'relay')
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new RelayOuterError(4408)))
      .mockReturnValueOnce(new FakeRelaySession('connected'))
    const deps = dependencies({
      openRelay,
      openDirect: vi.fn(() => new FakeSession('disconnected')),
      randomBytes: () => new Uint8Array([128, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(openRelay).toHaveBeenCalledOnce()

    supervisor.nudge('app-resume')
    await vi.advanceTimersByTimeAsync(0)

    expect(openRelay).toHaveBeenCalledTimes(2)
    expect(logical.getState()).toBe('connected')
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('leaves physical relay probing to the session watchdog', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)
    await supervisor.start()

    supervisor.nudge('focus')
    await vi.advanceTimersByTimeAsync(0)
    expect(logical.sendRequest).not.toHaveBeenCalled()
    expect(logical.suspendActiveSession).not.toHaveBeenCalled()
    expect(deps.openRelay).not.toHaveBeenCalled()

    supervisor.nudge('focus')
    await vi.advanceTimersByTimeAsync(0)
    expect(logical.sendRequest).not.toHaveBeenCalled()
    supervisor.stop()
  })

  it('withdraws the racing relay dial when direct authenticated while it was in flight', async () => {
    // Withdraw if direct wins before relay authentication; never close the winning session.
    const directSession = new FakeSession('connecting')
    const logical = createStableLogicalRpcClient(directSession, 'lan')
    const relaySession = new FakeRelaySession('connecting')
    const controller = new RelayReconnectController(dependencies(), vi.fn())
    const setActiveSession = vi.spyOn(controller, 'setActiveSession')
    const establisher = new MobileRelaySessionEstablisher({
      logical,
      controller,
      openRelay: vi.fn(() => relaySession),
      randomBytes: (length) => new Uint8Array(length),
      writeBundle: vi.fn(async () => {}),
      isActive: () => true,
      isForeground: () => true,
      isStopped: () => false,
      hostId: host.id,
      relay,
      resolveRelay: vi.fn(async ({ relay: endpoint }) => endpoint),
      setRelayRouting: vi.fn(async () => {}),
      bundle: () => bundle,
      adoptBundle: vi.fn(),
      recordMigration: vi.fn(),
      scheduleLease: vi.fn(),
      scheduleDirectProbe: vi.fn(),
      onBookkeepingError: vi.fn(),
      onDialFailure: vi.fn()
    })

    const dialing = establisher.dialEligible([bundle.current])
    expect(logical.getState()).toBe('connecting')
    expect(relaySession.close).not.toHaveBeenCalled()
    directSession.publishState('connected')
    relaySession.publishState('connected')
    const outcome = await dialing
    expect(outcome).toEqual({ outcome: 'aborted' })
    expect(setActiveSession).not.toHaveBeenCalled()
    expect(relaySession.close).toHaveBeenCalled()
    expect(logical.getActivePath()).toBe('lan')
    expect(logical.getGeneration()).toBe(1)
    expect(directSession.close).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    logical.close()
  })

  it('withdraws a relay replacement that authenticates after backgrounding', async () => {
    const activeRelay = new FakeSession('connected')
    const logical = createStableLogicalRpcClient(activeRelay, 'relay')
    const relaySession = new FakeRelaySession('connecting')
    const controller = new RelayReconnectController(dependencies(), vi.fn())
    const setActiveSession = vi.spyOn(controller, 'setActiveSession')
    let active = true
    const establisher = new MobileRelaySessionEstablisher({
      logical,
      controller,
      openRelay: vi.fn(() => relaySession),
      randomBytes: (length) => new Uint8Array(length),
      writeBundle: vi.fn(async () => {}),
      isActive: () => active,
      isForeground: () => active,
      isStopped: () => false,
      hostId: host.id,
      relay,
      resolveRelay: vi.fn(async ({ relay: endpoint }) => endpoint),
      setRelayRouting: vi.fn(async () => {}),
      bundle: () => bundle,
      adoptBundle: vi.fn(),
      recordMigration: vi.fn(),
      scheduleLease: vi.fn(),
      scheduleDirectProbe: vi.fn(),
      onBookkeepingError: vi.fn(),
      onDialFailure: vi.fn()
    })

    const dialing = establisher.dialEligible([bundle.current])
    expect(relaySession.close).not.toHaveBeenCalled()
    active = false
    relaySession.publishState('connected')
    const outcome = await dialing

    expect(outcome).toEqual({ outcome: 'aborted' })
    expect(setActiveSession).not.toHaveBeenCalled()
    expect(relaySession.close).toHaveBeenCalledOnce()
    expect(logical.getActivePath()).toBe('relay')
    expect(logical.getGeneration()).toBe(1)
    expect(activeRelay.close).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    logical.close()
  })
})
