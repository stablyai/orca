import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import type { MobileRelayRpcSession } from './mobile-relay-rpc-session'
import {
  MobileEndpointSupervisor,
  type MobileEndpointSupervisorDependencies
} from './mobile-endpoint-supervisor'
import type { RpcClient } from './rpc-client'
import {
  LogicalClientAuthenticationError,
  type MobileConnectionPath,
  type StableLogicalRpcClient
} from './stable-logical-rpc-client'
import type { ConnectionState, HostProfile, RpcResponse } from './types'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

class FakeSession implements RpcClient {
  readonly sendRequest = vi.fn(
    async (): Promise<RpcResponse> => ({
      id: 'rpc-1',
      ok: true,
      result: {},
      _meta: { runtimeId: 'runtime-1' }
    })
  )
  readonly subscribe = vi.fn(() => () => {})
  readonly updateTerminalSubscriptionViewport = vi.fn()
  readonly notifyForeground = vi.fn()
  readonly close = vi.fn()
  private readonly listeners = new Set<(state: ConnectionState) => void>()

  constructor(private state: ConnectionState) {}

  getState = () => this.state
  getReconnectAttempt = () => 0
  getLastConnectedAt = () => null
  onStateChange = (listener: (state: ConnectionState) => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  publishState(state: ConnectionState): void {
    this.state = state
    for (const listener of this.listeners) {
      listener(state)
    }
  }
}

class FakeRelaySession extends FakeSession implements MobileRelayRpcSession {
  constructor(
    state: ConnectionState,
    private readonly failure: Error | null = null
  ) {
    super(state)
  }
  getLeaseExpiresAt = () => Date.now() + 120_000
  getResumeConfirmation = () => null
  getFailure = () => this.failure
}

class FakeLogicalClient extends FakeSession implements StableLogicalRpcClient {
  private path: MobileConnectionPath
  private generation = 1
  private routeOwnerAttempt = 0

  constructor(state: ConnectionState, path: MobileConnectionPath) {
    super(state)
    this.path = path
  }

  migrateTo = vi.fn(async (session: RpcClient, path: MobileConnectionPath) => {
    if (session.getState() !== 'connected') {
      session.close()
      throw new Error(`replacement session ${session.getState()}`)
    }
    this.path = path
    this.generation++
    this.publishState('connected')
  })
  suspendActiveSession = vi.fn(() => this.publishState('disconnected'))
  getActivePath = () => this.path
  setActivePath = (path: MobileConnectionPath) => {
    this.path = path
  }
  getReconnectAttempt = () => this.routeOwnerAttempt
  publishRouteOwnerState = (state: ConnectionState, reconnectAttempt?: number) => {
    if (reconnectAttempt !== undefined) {
      this.routeOwnerAttempt = reconnectAttempt
    }
    this.publishState(state)
  }
  getGeneration = () => this.generation
}

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
}
const directUrl = 'ws://192.168.1.10:6768'
const relayUrl = 'wss://relay-c1.onorca.dev/v1/connect/AbCdEf0123_-xyZ9'
const host: HostProfile = {
  id: 'host-1',
  name: 'Blue Whale',
  endpoint: directUrl,
  deviceToken: 'device-token',
  publicKeyB64: 'A'.repeat(44),
  lastConnected: 1,
  routeOrder: 1,
  endpoints: [
    { id: 'direct-primary', kind: 'lan', url: directUrl },
    { id: 'relay-primary', kind: 'relay', url: relayUrl }
  ],
  relayHostId: relay.relayHostId,
  relay
}
const bundle: MobileRelayCredentialBundle = {
  v: 1,
  hostId: host.id,
  deviceToken: host.deviceToken,
  current: {
    token: 'A'.repeat(43),
    hash: 'B'.repeat(43),
    version: 2,
    expiresAt: Number.MAX_SAFE_INTEGER
  }
}

function dependencies(
  events: string[],
  overrides: Partial<MobileEndpointSupervisorDependencies> = {}
): MobileEndpointSupervisorDependencies {
  return {
    openDirect: vi.fn(() => (events.push('direct'), new FakeSession('connected'))),
    openRelay: vi.fn(() => (events.push('relay'), new FakeRelaySession('connected'))),
    resolveRelay: vi.fn(async ({ relay }) => relay),
    readBundle: vi.fn(async () => bundle),
    writeBundle: vi.fn(async () => {}),
    deleteBundle: vi.fn(async () => {}),
    saveHost: vi.fn(async () => {}),
    updateLastGood: vi.fn(async (_hostId, url) => {
      events.push(`last:${url}`)
    }),
    now: Date.now,
    randomBytes: (length) => new Uint8Array(length).fill(1),
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    ...overrides
  }
}

describe('mobile endpoint supervisor ordered routing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'))
  })

  afterEach(() => vi.useRealTimers())

  it('uses direct first and does not race Relay when direct authenticates', async () => {
    const events: string[] = []
    const logical = new FakeLogicalClient('connecting', 'lan')
    const supervisor = new MobileEndpointSupervisor(logical, host, dependencies(events))

    await supervisor.start()

    expect(events).toEqual(['direct', `last:${directUrl}`])
    expect(logical.getActivePath()).toBe('lan')
    supervisor.stop()
  })

  it('starts direct-first routing while Relay credential storage is stalled', async () => {
    const events: string[] = []
    const deps = dependencies(events, {
      readBundle: vi.fn(() => new Promise<MobileRelayCredentialBundle | null>(() => {}))
    })
    const logical = new FakeLogicalClient('connecting', 'lan')
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()

    expect(deps.openDirect).toHaveBeenCalledOnce()
    expect(logical.getState()).toBe('connected')
    supervisor.stop()
  })

  it('does not let stalled last-good persistence wedge later reconnects', async () => {
    const events: string[] = []
    const deps = dependencies(events, {
      updateLastGood: vi.fn(() => new Promise<void>(() => {}))
    })
    const logical = new FakeLogicalClient('connecting', 'lan')
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    logical.publishState('disconnected')
    await vi.waitFor(() => expect(deps.openDirect).toHaveBeenCalledTimes(2))

    expect(logical.getState()).toBe('connected')
    supervisor.stop()
  })

  it('advances from an unreachable direct route to Relay in configured order', async () => {
    const events: string[] = []
    const deps = dependencies(events, {
      openDirect: vi.fn(() => (events.push('direct'), new FakeSession('disconnected')))
    })
    const logical = new FakeLogicalClient('reconnecting', 'lan')
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()

    expect(events).toEqual(['direct', 'relay', `last:${relayUrl}`])
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('advances when constructing a direct route throws synchronously', async () => {
    const events: string[] = []
    const deps = dependencies(events, {
      openDirect: vi.fn(() => {
        events.push('direct')
        throw new Error('invalid WebSocket URL')
      })
    })
    const logical = new FakeLogicalClient('reconnecting', 'lan')
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()

    expect(events).toEqual(['direct', 'relay', `last:${relayUrl}`])
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('schedules another pass when the reconnect budget is exhausted', async () => {
    const events: string[] = []
    let now = 0
    const deps = dependencies(events, {
      now: () => {
        const current = now
        now = 20_000
        return current
      }
    })
    const logical = new FakeLogicalClient('reconnecting', 'lan')
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()

    expect(deps.openDirect).not.toHaveBeenCalled()
    expect(logical.getReconnectAttempt()).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    supervisor.stop()
  })

  it('owns visible reconnect attempts and uses bounded backoff between passes', async () => {
    const events: string[] = []
    const deps = dependencies(events, {
      openDirect: vi.fn(() => new FakeSession('disconnected')),
      openRelay: vi.fn(() => new FakeRelaySession('disconnected'))
    })
    const logical = new FakeLogicalClient('connecting', 'lan')
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    expect(logical.getState()).toBe('reconnecting')
    expect(logical.getReconnectAttempt()).toBe(1)
    expect(deps.openDirect).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(499)
    expect(deps.openDirect).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(deps.openDirect).toHaveBeenCalledTimes(2))
    expect(logical.getReconnectAttempt()).toBe(2)
    supervisor.stop()
  })

  it('uses a direct route when the optional Relay credential bundle is unavailable', async () => {
    const events: string[] = []
    const relayFirst = { ...host, endpoints: host.endpoints!.toReversed() }
    const deps = dependencies(events, { readBundle: vi.fn(async () => null) })
    const logical = new FakeLogicalClient('connecting', 'lan')
    const supervisor = new MobileEndpointSupervisor(logical, relayFirst, deps)

    await supervisor.start()

    expect(events).toEqual(['direct', `last:${directUrl}`])
    expect(logical.getActivePath()).toBe('lan')
    supervisor.stop()
  })

  it('owns ordered direct-only hosts without requiring Relay state', async () => {
    const events: string[] = []
    const directOnly: HostProfile = {
      ...host,
      endpoints: [
        { id: 'direct-primary', kind: 'lan', url: directUrl },
        { id: 'direct-1', kind: 'tailscale', url: 'ws://100.100.10.20:6768' }
      ],
      relayHostId: undefined,
      relay: undefined
    }
    const deps = dependencies(events)
    const logical = new FakeLogicalClient('connecting', 'lan')
    const supervisor = new MobileEndpointSupervisor(logical, directOnly, deps)

    await supervisor.start()

    expect(events).toEqual(['direct', `last:${directUrl}`])
    expect(deps.readBundle).not.toHaveBeenCalled()
    supervisor.stop()
  })

  it('honors Relay-first without opening a direct socket', async () => {
    const events: string[] = []
    const relayFirst = { ...host, endpoints: host.endpoints!.toReversed() }
    const logical = new FakeLogicalClient('connecting', 'relay')
    const supervisor = new MobileEndpointSupervisor(logical, relayFirst, dependencies(events))

    await supervisor.start()

    expect(events).toEqual(['relay', `last:${relayUrl}`])
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('hoists a sticky last-good Relay over configured direct-first order', async () => {
    const events: string[] = []
    const stickyRelay = { ...host, lastGoodEndpoint: relayUrl }
    const logical = new FakeLogicalClient('reconnecting', 'lan')
    const supervisor = new MobileEndpointSupervisor(logical, stickyRelay, dependencies(events))

    await supervisor.start()

    expect(events[0]).toBe('relay')
    expect(events).not.toContain('direct')
    supervisor.stop()
  })

  it('stops retrying a failed sticky route before configured order every pass', async () => {
    const events: string[] = []
    const stickyRelay = { ...host, lastGoodEndpoint: relayUrl }
    const deps = dependencies(events, {
      openDirect: vi.fn(() => (events.push('direct'), new FakeSession('disconnected'))),
      openRelay: vi.fn(() => (events.push('relay'), new FakeRelaySession('disconnected')))
    })
    const logical = new FakeLogicalClient('reconnecting', 'lan')
    const supervisor = new MobileEndpointSupervisor(logical, stickyRelay, deps)

    await supervisor.start()
    expect(events).toEqual(['relay', 'relay', 'direct'])

    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => expect(events).toHaveLength(6))
    expect(events).toEqual(['relay', 'relay', 'direct', 'direct', 'relay', 'relay'])
    supervisor.stop()
  })

  it('treats pinned Relay authentication failure as terminal', async () => {
    const events: string[] = []
    const relayFirst = { ...host, endpoints: host.endpoints!.toReversed() }
    const deps = dependencies(events)
    const logical = new FakeLogicalClient('connecting', 'relay')
    logical.migrateTo.mockRejectedValueOnce(
      new LogicalClientAuthenticationError('replacement session auth-failed')
    )
    const supervisor = new MobileEndpointSupervisor(logical, relayFirst, deps)

    await supervisor.start()

    expect(events).toEqual(['relay'])
    expect(deps.openDirect).not.toHaveBeenCalled()
    expect(logical.getState()).toBe('auth-failed')
    supervisor.stop()
  })

  it('keeps an authenticated Relay winner when confirmation persistence fails', async () => {
    const events: string[] = []
    const relayFirst = { ...host, endpoints: host.endpoints!.toReversed() }
    const relaySession = new FakeRelaySession('connected')
    vi.spyOn(relaySession, 'getResumeConfirmation').mockReturnValue({
      v: 1,
      reqId: 'confirm-1',
      currentVersion: bundle.current.version,
      acceptedAs: 'current',
      renewed: true,
      resumeExpiresAt: Date.now() + 300_000
    })
    const deps = dependencies(events, {
      openRelay: vi.fn(() => (events.push('relay'), relaySession)),
      writeBundle: vi.fn(async () => {
        throw new Error('keychain unavailable')
      })
    })
    const logical = new FakeLogicalClient('connecting', 'relay')
    const supervisor = new MobileEndpointSupervisor(logical, relayFirst, deps)

    await supervisor.start()

    expect(events).toEqual(['relay', `last:${relayUrl}`])
    expect(deps.openDirect).not.toHaveBeenCalled()
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('adopts Relay and schedules its lease when confirmation persistence stalls', async () => {
    const events: string[] = []
    const relayFirst = { ...host, endpoints: host.endpoints!.toReversed() }
    const relaySession = new FakeRelaySession('connected')
    relaySession.getResumeConfirmation = () => ({
      v: 1,
      reqId: 'confirm-1',
      currentVersion: bundle.current.version,
      acceptedAs: 'current',
      renewed: true,
      resumeExpiresAt: Date.now() + 300_000
    })
    const deps = dependencies(events, {
      openRelay: vi.fn(() => (events.push('relay'), relaySession)),
      writeBundle: vi.fn(() => new Promise<void>(() => {}))
    })
    const logical = new FakeLogicalClient('connecting', 'relay')
    const supervisor = new MobileEndpointSupervisor(logical, relayFirst, deps)

    await supervisor.start()

    expect(logical.getActivePath()).toBe('relay')
    expect(deps.writeBundle).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    supervisor.stop()
  })

  it('releases a Relay migration that finishes after the app backgrounds', async () => {
    const events: string[] = []
    const relayFirst = { ...host, endpoints: host.endpoints!.toReversed() }
    const relaySession = new FakeRelaySession('connected')
    relaySession.getResumeConfirmation = () => ({
      v: 1,
      reqId: 'confirm-1',
      currentVersion: bundle.current.version,
      acceptedAs: 'current',
      renewed: true,
      resumeExpiresAt: Date.now() + 300_000
    })
    const deps = dependencies(events, {
      openRelay: vi.fn(() => (events.push('relay'), relaySession)),
      // Why: lifecycle fencing cannot wait for a locked or stalled SecureStore.
      writeBundle: vi.fn(() => new Promise<void>(() => {}))
    })
    const logical = new FakeLogicalClient('connecting', 'lan')
    let finishMigration!: () => void
    logical.migrateTo.mockImplementationOnce(
      async (_session: RpcClient, path: MobileConnectionPath) => {
        await new Promise<void>((resolve) => {
          finishMigration = resolve
        })
        logical.setActivePath(path)
        logical.publishState('connected')
      }
    )
    const supervisor = new MobileEndpointSupervisor(logical, relayFirst, deps)

    const starting = supervisor.start()
    await vi.waitFor(() => expect(deps.openRelay).toHaveBeenCalledOnce())
    supervisor.setForeground(false)
    finishMigration()
    await starting

    expect(logical.suspendActiveSession).toHaveBeenCalled()
    expect(deps.openRelay).toHaveBeenCalledOnce()
    expect(deps.writeBundle).toHaveBeenCalledOnce()
    expect(logical.getState()).toBe('disconnected')
    supervisor.stop()
  })

  it('does not retry a Relay migration rejected while backgrounding', async () => {
    const events: string[] = []
    const relayFirst = { ...host, endpoints: host.endpoints!.toReversed() }
    const deps = dependencies(events)
    const logical = new FakeLogicalClient('connecting', 'lan')
    let rejectMigration!: () => void
    logical.migrateTo.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        rejectMigration = resolve
      })
      throw new Error('client closed')
    })
    const supervisor = new MobileEndpointSupervisor(logical, relayFirst, deps)

    const starting = supervisor.start()
    await vi.waitFor(() => expect(deps.openRelay).toHaveBeenCalledOnce())
    supervisor.setForeground(false)
    rejectMigration()
    await starting

    expect(deps.openRelay).toHaveBeenCalledOnce()
    expect(deps.resolveRelay).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    supervisor.stop()
  })

  it('does not schedule a retry when the final direct route fails after backgrounding', async () => {
    const events: string[] = []
    const directOnly = {
      ...host,
      endpoints: host.endpoints!.filter(({ kind }) => kind !== 'relay'),
      relayHostId: undefined,
      relay: undefined
    }
    const deps = dependencies(events)
    const logical = new FakeLogicalClient('connecting', 'lan')
    let rejectMigration!: () => void
    logical.migrateTo.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        rejectMigration = resolve
      })
      throw new Error('client closed')
    })
    const supervisor = new MobileEndpointSupervisor(logical, directOnly, deps)

    const starting = supervisor.start()
    await vi.waitFor(() => expect(deps.openDirect).toHaveBeenCalledOnce())
    supervisor.setForeground(false)
    rejectMigration()
    await starting

    expect(vi.getTimerCount()).toBe(0)
    supervisor.stop()
  })

  it('does not persist a director result that resolves after supervisor stop', async () => {
    const events: string[] = []
    const relayFirst = { ...host, endpoints: host.endpoints!.toReversed() }
    let finishResolution!: () => void
    const deps = dependencies(events, {
      openRelay: vi.fn(() => new FakeRelaySession('disconnected', new RelayOuterError(4409))),
      resolveRelay: vi.fn(
        () =>
          new Promise<typeof relay>((resolve) => {
            finishResolution = () => resolve(relay)
          })
      )
    })
    const logical = new FakeLogicalClient('connecting', 'relay')
    const supervisor = new MobileEndpointSupervisor(logical, relayFirst, deps)

    const starting = supervisor.start()
    await vi.waitFor(() => expect(deps.resolveRelay).toHaveBeenCalledOnce())
    supervisor.stop()
    finishResolution()
    await starting

    expect(deps.saveHost).not.toHaveBeenCalled()
    expect(deps.openRelay).toHaveBeenCalledOnce()
  })

  it('continues ordered fallback when corrected Relay host persistence stalls', async () => {
    const events: string[] = []
    const relayFirst = { ...host, endpoints: host.endpoints!.toReversed() }
    const deps = dependencies(events, {
      openRelay: vi.fn(() => new FakeRelaySession('disconnected', new RelayOuterError(4409))),
      saveHost: vi.fn(() => new Promise<void>(() => {}))
    })
    const logical = new FakeLogicalClient('connecting', 'relay')
    const supervisor = new MobileEndpointSupervisor(logical, relayFirst, deps)

    const starting = supervisor.start()
    await vi.waitFor(() => expect(deps.saveHost).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(3_500)
    await starting

    expect(deps.openDirect).toHaveBeenCalledOnce()
    expect(logical.getActivePath()).toBe('lan')
    supervisor.stop()
  })

  it('backs off repeated failed lease replacements', async () => {
    const events: string[] = []
    const scheduledDelays: number[] = []
    const relayFirst = { ...host, endpoints: host.endpoints!.toReversed() }
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('connected'))
      .mockImplementation(() => new FakeRelaySession('disconnected', new RelayOuterError(4404)))
    const deps = dependencies(events, {
      openRelay,
      openDirect: vi.fn(() => new FakeSession('disconnected')),
      setTimer: ((callback: () => void, delay?: number) => {
        scheduledDelays.push(delay ?? 0)
        return setTimeout(callback, delay)
      }) as typeof setTimeout
    })
    const logical = new FakeLogicalClient('connecting', 'relay')
    const supervisor = new MobileEndpointSupervisor(logical, relayFirst, deps)
    await supervisor.start()

    await vi.advanceTimersToNextTimerAsync()
    expect(openRelay).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(500)
    expect(openRelay).toHaveBeenCalledTimes(3)
    expect(scheduledDelays.filter((delay) => delay === 500 || delay === 1_000)).toEqual([
      500, 1_000
    ])
    supervisor.stop()
  })

  it('does not restart route traversal after an active session becomes auth-failed', async () => {
    const events: string[] = []
    const deps = dependencies(events)
    const logical = new FakeLogicalClient('connected', 'lan')
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    logical.publishState('auth-failed')
    await Promise.resolve()

    expect(deps.openDirect).not.toHaveBeenCalled()
    expect(deps.openRelay).not.toHaveBeenCalled()
    supervisor.stop()
  })

  it('releases Relay in background and reconnects sticky Relay on foreground', async () => {
    const events: string[] = []
    const stickyRelay = { ...host, lastGoodEndpoint: relayUrl }
    const logical = new FakeLogicalClient('connected', 'relay')
    const supervisor = new MobileEndpointSupervisor(logical, stickyRelay, dependencies(events))
    await supervisor.start()

    supervisor.setForeground(false)
    supervisor.setForeground(true)
    await vi.waitFor(() => expect(logical.getState()).toBe('connected'))

    expect(events[0]).toBe('relay')
    supervisor.stop()
  })
})
