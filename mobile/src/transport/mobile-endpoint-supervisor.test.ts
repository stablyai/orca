import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import { hashMobileRelayCredential } from './mobile-relay-credential-hash'
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
    this.publishState('connected')
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
    deleteBundle: vi.fn(async () => {}),
    reprovisionRelay: vi.fn(async () => ({ host, bundle })),
    saveHost: vi.fn(async () => {}),
    onLog: vi.fn(),
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

  it('waits for stored credentials before reacting to an early foreground signal', async () => {
    const logical = new FakeLogicalClient('connected', 'lan')
    let finishRead!: (value: MobileRelayCredentialBundle) => void
    const readBundle = vi.fn(
      () =>
        new Promise<MobileRelayCredentialBundle>((resolve) => {
          finishRead = resolve
        })
    )
    const deps = dependencies({ readBundle })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    const starting = supervisor.start()
    supervisor.setForeground(true)
    await Promise.resolve()

    expect(deps.reprovisionRelay).not.toHaveBeenCalled()
    expect(deps.openRelay).not.toHaveBeenCalled()
    finishRead(bundle)
    await starting

    expect(deps.reprovisionRelay).not.toHaveBeenCalled()
    expect(deps.onLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Relay credential unavailable' })
    )
    supervisor.stop()
  })

  it('reprovisions a missing relay credential after authenticated direct startup', async () => {
    const logical = new FakeLogicalClient('connected', 'lan')
    const reprovisionRelay = vi.fn(async () => ({ host, bundle }))
    const deps = dependencies({
      readBundle: vi.fn(async () => null),
      reprovisionRelay
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()

    expect(reprovisionRelay).toHaveBeenCalledWith(logical, host)
    logical.publishState('reconnecting')
    await vi.waitFor(() => expect(logical.getActivePath()).toBe('relay'))
    expect(deps.onLog).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'success', message: 'Relay credential restored' })
    )
    supervisor.stop()
  })

  it('reprovisions when every stored relay credential is expired', async () => {
    const logical = new FakeLogicalClient('connected', 'lan')
    const expired = {
      ...bundle,
      current: { ...bundle.current, expiresAt: Date.now() - 1 }
    }
    const reprovisionRelay = vi.fn(async () => ({ host, bundle }))
    const deps = dependencies({
      readBundle: vi.fn(async () => expired),
      reprovisionRelay
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()

    expect(reprovisionRelay).toHaveBeenCalledOnce()
    expect(deps.onLog).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', message: 'Relay credential unavailable' })
    )
    supervisor.stop()
  })

  it('disables a rejected relay credential and restores it on the next direct connection', async () => {
    const logical = new FakeLogicalClient('reconnecting', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('disconnected', new RelayOuterError(4401)))
    const reprovisionRelay = vi.fn(async () => ({ host, bundle }))
    const deps = dependencies({ openRelay, reprovisionRelay })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    logical.publishState('connected')
    await vi.waitFor(() => expect(reprovisionRelay).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(15_000)

    expect(openRelay).toHaveBeenCalledOnce()
    expect(deps.onLog).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', message: 'Relay credential rejected' })
    )
    const renderedLogs = JSON.stringify((deps.onLog as ReturnType<typeof vi.fn>).mock.calls)
    expect(renderedLogs).not.toContain(bundle.current.token)
    expect(renderedLogs).not.toContain(bundle.current.hash)
    expect(renderedLogs).not.toContain(bundle.deviceToken)
    supervisor.stop()
  })

  it('retries a usable grace credential after current is rejected and grace briefly fails', async () => {
    const logical = new FakeLogicalClient('reconnecting', 'lan')
    const bundleWithGrace: MobileRelayCredentialBundle = {
      ...bundle,
      grace: {
        token: 'C'.repeat(43),
        hash: 'D'.repeat(43),
        version: 1,
        expiresAt: Number.MAX_SAFE_INTEGER
      }
    }
    let graceAttempts = 0
    const openRelay = vi.fn((_relay, credential: { token: string; version: number }) => {
      if (credential.version === bundle.current.version) {
        return new FakeRelaySession('disconnected', new RelayOuterError(4401))
      }
      graceAttempts += 1
      return graceAttempts === 1
        ? new FakeRelaySession('disconnected', new RelayOuterError(4408))
        : new FakeRelaySession('connected')
    })
    const deps = dependencies({
      readBundle: vi.fn(async () => bundleWithGrace),
      openRelay
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    expect(openRelay).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(4_999)
    expect(openRelay).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1)

    expect(openRelay).toHaveBeenCalledTimes(3)
    expect(openRelay.mock.calls.map((call) => call[1].version)).toEqual([2, 1, 1])
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('recovers relay when direct disconnects while credential reprovision is in flight', async () => {
    const logical = new FakeLogicalClient('connected', 'lan')
    let finishReprovision!: (result: {
      host: HostProfile
      bundle: MobileRelayCredentialBundle
    }) => void
    const reprovisionRelay = vi.fn(
      () =>
        new Promise<{ host: HostProfile; bundle: MobileRelayCredentialBundle }>((resolve) => {
          finishReprovision = resolve
        })
    )
    const deps = dependencies({
      readBundle: vi.fn(async () => null),
      reprovisionRelay
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    const starting = supervisor.start()
    await vi.waitFor(() => expect(reprovisionRelay).toHaveBeenCalledOnce())
    logical.publishState('reconnecting')
    finishReprovision({ host, bundle })
    await starting
    await vi.waitFor(() => expect(logical.getActivePath()).toBe('relay'))

    expect(deps.openRelay).toHaveBeenCalledOnce()
    supervisor.stop()
  })

  it('retries transient credential reprovision failure while direct stays authenticated', async () => {
    const logical = new FakeLogicalClient('connected', 'lan')
    const reprovisionRelay = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary direct RPC failure'))
      .mockResolvedValueOnce({ host, bundle })
    const deps = dependencies({
      readBundle: vi.fn(async () => null),
      reprovisionRelay
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    expect(reprovisionRelay).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(4_999)
    expect(reprovisionRelay).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(1)

    expect(reprovisionRelay).toHaveBeenCalledTimes(2)
    expect(deps.openRelay).not.toHaveBeenCalled()
    expect(deps.onLog).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'success', message: 'Relay credential restored' })
    )
    logical.publishState('reconnecting')
    await vi.waitFor(() => expect(logical.getActivePath()).toBe('relay'))
    supervisor.stop()
  })

  it('retries transient credential reprovision failure after relay migrates to direct', async () => {
    const logical = new FakeLogicalClient('reconnecting', 'lan')
    const bundleWithGrace: MobileRelayCredentialBundle = {
      ...bundle,
      grace: {
        token: 'C'.repeat(43),
        hash: 'D'.repeat(43),
        version: 1,
        expiresAt: Number.MAX_SAFE_INTEGER
      }
    }
    const openRelay = vi.fn((_relay, credential: { token: string; version: number }) =>
      credential.version === bundle.current.version
        ? new FakeRelaySession('disconnected', new RelayOuterError(4401))
        : new FakeRelaySession('connected')
    )
    const reprovisionRelay = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary direct RPC failure'))
      .mockResolvedValueOnce({ host, bundle })
    const deps = dependencies({
      readBundle: vi.fn(async () => bundleWithGrace),
      openRelay,
      reprovisionRelay
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(logical.getActivePath()).toBe('lan')
    expect(reprovisionRelay).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(4_999)
    expect(reprovisionRelay).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(1)

    expect(reprovisionRelay).toHaveBeenCalledTimes(2)
    supervisor.stop()
  })

  it('recovers relay when direct drops before a deferred credential retry', async () => {
    const logical = new FakeLogicalClient('reconnecting', 'lan')
    const bundleWithGrace: MobileRelayCredentialBundle = {
      ...bundle,
      grace: {
        token: 'C'.repeat(43),
        hash: 'D'.repeat(43),
        version: 1,
        expiresAt: Number.MAX_SAFE_INTEGER
      }
    }
    let graceAttempts = 0
    const openRelay = vi.fn((_relay, credential: { token: string; version: number }) => {
      if (credential.version === bundle.current.version) {
        return new FakeRelaySession('disconnected', new RelayOuterError(4401))
      }
      graceAttempts += 1
      return graceAttempts === 2
        ? new FakeRelaySession('disconnected', new RelayOuterError(4408))
        : new FakeRelaySession('connected')
    })
    const deps = dependencies({
      readBundle: vi.fn(async () => bundleWithGrace),
      openRelay,
      reprovisionRelay: vi.fn(async () => {
        throw new Error('temporary direct RPC failure')
      })
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(logical.getActivePath()).toBe('lan')

    logical.publishState('disconnected')
    await vi.waitFor(() => expect(openRelay).toHaveBeenCalledTimes(3))
    await vi.advanceTimersByTimeAsync(5_000)

    expect(openRelay).toHaveBeenCalledTimes(4)
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('reprovisions when direct wins while an in-flight relay attempt is rejected', async () => {
    const logical = new FakeLogicalClient('reconnecting', 'lan')
    let rejectMigration!: () => void
    logical.migrateTo = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectMigration = () => reject(new Error('replacement rejected'))
        })
    )
    const token = 'E'.repeat(43)
    const validBundle: MobileRelayCredentialBundle = {
      ...bundle,
      current: {
        ...bundle.current,
        token,
        hash: hashMobileRelayCredential(token)
      }
    }
    const openRelay = vi.fn(() => new FakeRelaySession('disconnected', new RelayOuterError(4401)))
    const reprovisionRelay = vi.fn(async () => ({ host, bundle: validBundle }))
    const deps = dependencies({
      readBundle: vi.fn(async () => validBundle),
      openRelay,
      reprovisionRelay
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    const starting = supervisor.start()
    await vi.waitFor(() => expect(openRelay).toHaveBeenCalledOnce())
    logical.publishState('connected')
    expect(reprovisionRelay).not.toHaveBeenCalled()
    rejectMigration()
    await starting
    await vi.waitFor(() => expect(reprovisionRelay).toHaveBeenCalledOnce())

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

  it('retries relay recovery while the foreground direct client remains reconnecting', async () => {
    const logical = new FakeLogicalClient('reconnecting', 'lan')
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new Error('relay unavailable')))
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new Error('relay unavailable')))
      .mockReturnValueOnce(new FakeRelaySession('connected'))
    const deps = dependencies({ openRelay })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    expect(logical.getActivePath()).toBe('lan')

    await vi.advanceTimersByTimeAsync(5_000)

    expect(openRelay).toHaveBeenCalledTimes(3)
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('retries a dropped relay before the previous lease rotation deadline', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('connected'))
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new RelayOuterError(4408)))
      .mockReturnValueOnce(new FakeRelaySession('connected'))
    const deps = dependencies({ openRelay })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    expect(openRelay).toHaveBeenCalledOnce()

    logical.publishState('reconnecting')
    await vi.waitFor(() => expect(openRelay).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(5_000)

    expect(openRelay).toHaveBeenCalledTimes(3)
    supervisor.stop()
  })

  it('cancels an older forced retry after a newer relay recovery succeeds', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('connected', null, Date.now() + 31_000))
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new RelayOuterError(4408)))
      .mockReturnValueOnce(new FakeRelaySession('connected'))
      .mockReturnValueOnce(new FakeRelaySession('connected'))
    const deps = dependencies({ openRelay })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(openRelay).toHaveBeenCalledTimes(2)

    supervisor.setForeground(true)
    await vi.waitFor(() => expect(openRelay).toHaveBeenCalledTimes(3))
    await vi.advanceTimersByTimeAsync(5_000)

    expect(openRelay).toHaveBeenCalledTimes(3)
    supervisor.stop()
  })

  it('recovers a relay disconnect that occurs while confirmation persistence is pending', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const migrate = logical.migrateTo
    logical.migrateTo = vi.fn(async (session, path) => {
      await migrate(session, path)
      logical.publishState('connected')
    })
    let finishFirstWrite!: () => void
    const writeBundle = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirstWrite = resolve
          })
      )
      .mockResolvedValue(undefined)
    const openRelay = vi.fn(() => new FakeRelaySession('connected'))
    const deps = dependencies({ openRelay, writeBundle })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    const starting = supervisor.start()
    await vi.waitFor(() => expect(writeBundle).toHaveBeenCalledOnce())
    logical.publishState('disconnected')
    finishFirstWrite()
    await starting
    await vi.waitFor(() => expect(openRelay).toHaveBeenCalledTimes(2))

    expect(logical.getState()).toBe('connected')
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

  it('does not promote a direct probe that authenticates after the app backgrounds', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const pendingDirect = new FakeSession('connecting')
    const openDirect = vi
      .fn()
      .mockReturnValueOnce(new FakeSession('connected'))
      .mockReturnValueOnce(new FakeSession('connected'))
      .mockReturnValueOnce(new FakeSession('connected'))
      .mockReturnValueOnce(pendingDirect)
    const deps = dependencies({ openDirect })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(openDirect).toHaveBeenCalledTimes(4)
    expect(logical.migrateTo).not.toHaveBeenCalled()

    supervisor.setForeground(false)
    pendingDirect.publishState('connected')
    await Promise.resolve()
    await Promise.resolve()

    expect(logical.migrateTo).not.toHaveBeenCalled()
    expect(pendingDirect.close).toHaveBeenCalledOnce()
    supervisor.stop()
  })

  it('recovers a relay disconnect that occurs while a direct probe is pending', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const migrate = logical.migrateTo
    logical.migrateTo = vi.fn(async (session, path) => {
      await migrate(session, path)
      logical.publishState('connected')
    })
    const pendingDirect = new FakeSession('connecting')
    const openRelay = vi.fn(() => new FakeRelaySession('connected'))
    const deps = dependencies({
      openDirect: vi.fn(() => pendingDirect),
      openRelay
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    await vi.advanceTimersByTimeAsync(15_000)
    logical.publishState('disconnected')
    pendingDirect.publishState('disconnected')
    await vi.waitFor(() => expect(openRelay).toHaveBeenCalledOnce())

    expect(logical.getState()).toBe('connected')
    supervisor.stop()
  })

  it('resuspends a direct migration that finishes after the app backgrounds', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const migrate = logical.migrateTo
    let releaseMigration!: () => void
    logical.migrateTo = vi.fn(async (session, path) => {
      await new Promise<void>((resolve) => {
        releaseMigration = resolve
      })
      await migrate(session, path)
    })
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(logical.migrateTo).toHaveBeenCalledOnce())

    supervisor.setForeground(false)
    expect(logical.suspendActiveSession).toHaveBeenCalledOnce()
    releaseMigration()
    await vi.waitFor(() => expect(logical.getActivePath()).toBe('lan'))

    expect(logical.suspendActiveSession).toHaveBeenCalledTimes(2)
    expect(logical.getState()).toBe('disconnected')
    supervisor.stop()
  })
})
