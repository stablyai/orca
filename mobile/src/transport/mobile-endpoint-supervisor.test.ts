import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import type { MobileRelayRpcSession } from './mobile-relay-rpc-session'
import {
  MobileEndpointSupervisor,
  type MobileEndpointSupervisorDependencies
} from './mobile-endpoint-supervisor'
import type { RpcClient } from './rpc-client'
import type { MobileConnectionPath, StableLogicalRpcClient } from './stable-logical-rpc-client'
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
    private readonly failure: Error | null = null,
    private readonly lease = Date.now() + 120_000
  ) {
    super(state)
  }
  getLeaseExpiresAt = () => this.lease
  getResumeConfirmation = () => ({
    v: 1 as const,
    reqId: 'confirm-1',
    currentVersion: 2,
    acceptedAs: 'current' as const,
    renewed: true,
    resumeExpiresAt: Date.now() + 300_000
  })
  getFailure = () => this.failure
}

class FakeLogicalClient extends FakeSession implements StableLogicalRpcClient {
  private path: MobileConnectionPath
  private generation = 1

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
    this.generation += 1
  })
  suspendActiveSession = vi.fn(() => this.publishState('disconnected'))
  getActivePath = () => this.path
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
const host: HostProfile = {
  id: 'host-1',
  name: 'Blue Whale',
  endpoint: 'ws://192.168.1.10:6768',
  deviceToken: 'device-token',
  publicKeyB64: 'A'.repeat(44),
  lastConnected: 1,
  endpoints: [
    { id: 'direct-primary', kind: 'lan', url: 'ws://192.168.1.10:6768' },
    { id: 'relay-primary', kind: 'relay', url: 'wss://relay-c1.onorca.dev/v1/connect/id' }
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
  overrides: Partial<MobileEndpointSupervisorDependencies> = {}
): MobileEndpointSupervisorDependencies {
  return {
    openDirect: vi.fn(() => new FakeSession('connected')),
    openRelay: vi.fn(() => new FakeRelaySession('connected')),
    resolveRelay: vi.fn(async ({ relay }) => relay),
    readBundle: vi.fn(async () => bundle),
    writeBundle: vi.fn(async () => {}),
    saveHost: vi.fn(async () => {}),
    now: Date.now,
    randomBytes: (length) => new Uint8Array(length).fill(1),
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    ...overrides
  }
}

describe('mobile endpoint supervisor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fails over to a confirmed relay session and persists its renewed expiry', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()

    expect(logical.migrateTo).toHaveBeenCalledWith(expect.any(FakeRelaySession), 'relay')
    expect(logical.getActivePath()).toBe('relay')
    expect(deps.writeBundle).toHaveBeenCalledWith(
      expect.objectContaining({ current: expect.objectContaining({ version: 2 }) })
    )
    supervisor.stop()
  })

  it('fails over when the direct retry loop publishes reconnecting', async () => {
    const logical = new FakeLogicalClient('connecting', 'lan')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    logical.publishState('reconnecting')
    await vi.waitFor(() => expect(logical.getActivePath()).toBe('relay'))

    expect(logical.migrateTo).toHaveBeenCalledWith(expect.any(FakeRelaySession), 'relay')
    supervisor.stop()
  })

  it('fails over when direct is already reconnecting before startup completes', async () => {
    const logical = new FakeLogicalClient('reconnecting', 'lan')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()

    expect(logical.migrateTo).toHaveBeenCalledWith(expect.any(FakeRelaySession), 'relay')
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('uses POST resolve for wrong-cell recovery and persists the authoritative target', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new RelayOuterError(4409)))
      .mockReturnValueOnce(new FakeRelaySession('connected'))
    const resolved = { ...relay, cellUrl: 'https://relay-c2.onorca.dev', assignmentEpoch: 8 }
    const deps = dependencies({
      openRelay,
      resolveRelay: vi.fn(async () => resolved)
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()

    expect(deps.resolveRelay).toHaveBeenCalledOnce()
    expect(openRelay).toHaveBeenLastCalledWith(resolved, expect.any(Object), expect.any(String))
    expect(deps.saveHost).toHaveBeenCalledWith(
      expect.objectContaining({ relay: resolved, endpoint: host.endpoint })
    )
    supervisor.stop()
  })

  it('promotes direct only after repeated foreground authenticated probes and dwell', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    await vi.advanceTimersByTimeAsync(45_000)
    expect(logical.getActivePath()).toBe('relay')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(logical.getActivePath()).toBe('lan')
    expect(deps.openDirect).toHaveBeenCalledTimes(4)
    supervisor.stop()
  })

  it('releases a background relay session and reconnects it on foreground', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    supervisor.setForeground(false)
    expect(logical.suspendActiveSession).toHaveBeenCalledOnce()
    expect(logical.getState()).toBe('disconnected')

    supervisor.setForeground(true)
    await vi.waitFor(() => expect(logical.migrateTo).toHaveBeenCalled())
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })
})
