import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect, type RpcClient } from './rpc-client'
import {
  createStableLogicalRpcClient,
  type MobileConnectionPath,
  type StableLogicalRpcClient
} from './stable-logical-rpc-client'
import { MobileE2EEAuthenticationError } from './mobile-e2ee-v2-physical-channel'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import type { MobileRelayRpcSession } from './mobile-relay-rpc-session'
import {
  MobileEndpointSupervisor,
  type MobileEndpointSupervisorDependencies
} from './mobile-endpoint-supervisor'
import type { ConnectionState, HostProfile, RpcResponse } from './types'

// Regression suite for the 2026-08 field failure: a phone paired over the
// relay whose direct LAN endpoint is unreachable (Tailscale off) dialed the
// LAN endpoint forever and never recovered a relay runtime session.

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }))
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked'
}))
vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length)
}))

vi.mock('./e2ee', () => ({
  generateKeyPair: () => ({
    publicKey: new Uint8Array(32),
    secretKey: new Uint8Array(32)
  }),
  deriveSharedKey: () => new Uint8Array(32),
  publicKeyFromBase64: () => new Uint8Array(32),
  publicKeyToBase64: () => 'client-public-key',
  encrypt: (plaintext: string) => plaintext,
  decrypt: (raw: string) => raw,
  decryptBytes: (bytes: Uint8Array) => bytes
}))

class FakeSession implements RpcClient {
  readonly sendRequest = vi.fn(async (): Promise<RpcResponse> => ({
    id: 'rpc-1',
    ok: true,
    result: {},
    _meta: { runtimeId: 'runtime-1' }
  }))
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
  // Why: production-realistic constants — fictional fake values hid three
  // live defects in this subsystem (latch, churn, int32 timer overflow).
  getAttachDeadlineAt = () => Date.now() + 10_000
  getResumeExpiresAt = () => Date.now() + 30 * 24 * 3_600_000
  getResumeConfirmation = () => null
  getFailure = () => this.failure
}

class FakeLogicalClient extends FakeSession implements StableLogicalRpcClient {
  private path: MobileConnectionPath
  private recoveryPath: MobileConnectionPath | null = null
  private recoveryAttempt = 0
  private generation = 1
  private readonly pathListeners = new Set<() => void>()

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
    this.recoveryPath = null
    this.recoveryAttempt = 0
    this.generation += 1
    // Connected-state publication carries the migration cleanup.
    this.publishState('connected')
  })
  suspendActiveSession = vi.fn(() => this.publishState('disconnected'))
  getReconnectAttempt = () => (this.getPendingPath() === 'relay' ? this.recoveryAttempt : 0)
  getActivePath = () => this.path
  getPendingPath = () => (this.getState() === 'connected' ? null : this.recoveryPath)
  setRecoveryPath = vi.fn((path: MobileConnectionPath | null, attempt?: number) => {
    const previous = this.getPendingPath()
    const previousAttempt = this.getReconnectAttempt()
    this.recoveryPath = path
    if (path === null) {
      this.recoveryAttempt = 0
    } else if (attempt !== undefined) {
      this.recoveryAttempt = attempt
    }
    if (previous !== this.getPendingPath() || previousAttempt !== this.getReconnectAttempt()) {
      for (const listener of this.pathListeners) {
        listener()
      }
    }
  })
  private pairingRejected = false
  setPairingRejected = vi.fn((rejected: boolean) => {
    if (this.pairingRejected === rejected) {
      return
    }
    this.pairingRejected = rejected
    for (const listener of this.pathListeners) {
      listener()
    }
  })
  isPairingRejected = () => this.pairingRejected
  // Mirrors LogicalClientConnectionPath.clearAfterConnected.
  publishState(state: ConnectionState): void {
    if (state === 'connected') {
      this.pairingRejected = false
    }
    super.publishState(state)
  }
  setRecoveryAttempt = vi.fn((attempt: number) => {
    const previous = this.getReconnectAttempt()
    this.recoveryAttempt = attempt
    if (previous !== this.getReconnectAttempt()) {
      for (const listener of this.pathListeners) {
        listener()
      }
    }
  })
  onConnectionPathChange = vi.fn((listener: () => void) => {
    this.pathListeners.add(listener)
    return () => this.pathListeners.delete(listener)
  })
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

const DIRECT_ENDPOINT = 'ws://100.88.90.25:6768'

const host: HostProfile = {
  id: 'host-1',
  name: 'Blue Whale',
  endpoint: DIRECT_ENDPOINT,
  deviceToken: 'device-token',
  publicKeyB64: 'A'.repeat(44),
  lastConnected: 1,
  endpoints: [
    { id: 'direct-primary', kind: 'lan', url: DIRECT_ENDPOINT },
    {
      id: 'relay-primary',
      kind: 'relay',
      url: 'wss://relay-c1.onorca.dev/v1/connect/id'
    }
  ],
  relayHostId: relay.relayHostId,
  relay
}

function bundleWith(version: number, expiresAt: number): MobileRelayCredentialBundle {
  return {
    v: 1,
    hostId: host.id,
    deviceToken: host.deviceToken,
    current: {
      token: `token-v${version}`.padEnd(43, 'A'),
      hash: 'B'.repeat(43),
      version,
      expiresAt
    }
  }
}

function dependencies(
  overrides: Partial<MobileEndpointSupervisorDependencies> = {}
): MobileEndpointSupervisorDependencies {
  return {
    openDirect: vi.fn(() => new FakeSession('connected')),
    openRelay: vi.fn(() => new FakeRelaySession('connected')),
    resolveRelay: vi.fn(async ({ relay }) => relay),
    readBundle: vi.fn(async () => bundleWith(2, Number.MAX_SAFE_INTEGER)),
    writeBundle: vi.fn(async () => {}),
    saveHost: vi.fn(async () => {}),
    now: Date.now,
    randomBytes: (length: number) => new Uint8Array(length),
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    ...overrides
  }
}

describe('relay runtime recovery without direct connectivity', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-02T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('recovers from a rejected outer credential once a fresher bundle is durable', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new RelayOuterError(4401)))
      .mockImplementation(() => new FakeRelaySession('connected'))
    const readBundle = vi
      .fn(async () => bundleWith(3, Number.MAX_SAFE_INTEGER))
      .mockResolvedValueOnce(bundleWith(2, Number.MAX_SAFE_INTEGER))
    const deps = dependencies({ openRelay, readBundle })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(openRelay).toHaveBeenCalledOnce()

    // Pre-fix, the fresh-credential gate latched here with no timer and no exit.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(openRelay).toHaveBeenCalledTimes(2)
    expect(openRelay).toHaveBeenLastCalledWith(
      relay,
      expect.objectContaining({ version: 3 }),
      expect.any(String)
    )
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('recovers when the credential bundle was unreadable at supervisor start', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const readBundle = vi
      .fn(async () => bundleWith(2, Number.MAX_SAFE_INTEGER))
      .mockResolvedValueOnce(null)
    const deps = dependencies({ readBundle })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    // Pre-fix, a null first read killed relay recovery for the process lifetime.
    await supervisor.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(deps.openRelay).toHaveBeenCalled()
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('recovers from an expired-at-start bundle after a fresh credential lands', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const expired = bundleWith(2, Date.now() - 1)
    const readBundle = vi.fn(async () => expired)
    const deps = dependencies({ readBundle })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.openRelay).not.toHaveBeenCalled()
    expect(logical.setRecoveryPath).not.toHaveBeenCalledWith('relay')
    expect(logical.getPendingPath()).toBeNull()

    readBundle.mockImplementation(async () => bundleWith(3, Number.MAX_SAFE_INTEGER))
    // Pre-fix, an expired bundle produced a silent no-op with nothing scheduled.
    await vi.advanceTimersByTimeAsync(60_000)

    expect(deps.openRelay).toHaveBeenCalledOnce()
    expect(logical.setRecoveryPath).toHaveBeenCalledWith('relay', 0)
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('retries after an E2EE authentication rejection without a UI nudge', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(
        new FakeRelaySession('disconnected', new MobileE2EEAuthenticationError())
      )
      .mockImplementation(() => new FakeRelaySession('connected'))
    const deps = dependencies({ openRelay })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(openRelay).toHaveBeenCalledOnce()

    // Pre-fix, this state waited indefinitely for a foreground/navigation event.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(openRelay).toHaveBeenCalledTimes(2)
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('adopts a durable renewal that extends expiry without bumping the version', async () => {
    // Why: resume confirmations and pairing recovery renew expiresAt while
    // keeping current.version — version comparison cannot see this freshness.
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const expired = bundleWith(2, Date.now() - 1)
    const readBundle = vi
      .fn(async () => bundleWith(2, Number.MAX_SAFE_INTEGER))
      .mockResolvedValueOnce(expired)
      .mockResolvedValueOnce(expired)
    const deps = dependencies({ readBundle })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.openRelay).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(deps.openRelay).toHaveBeenCalledOnce()
    expect(deps.openRelay).toHaveBeenLastCalledWith(
      relay,
      expect.objectContaining({ version: 2 }),
      expect.any(String)
    )
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('adopts a re-paired credential whose version counter restarted', async () => {
    // Why: re-pairing overwrites the same keychain slot with a NEW credential
    // record whose counter restarts at 1 — lower than the rejected version.
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(new FakeRelaySession('disconnected', new RelayOuterError(4401)))
      .mockImplementation(() => new FakeRelaySession('connected'))
    const readBundle = vi
      .fn(async () => bundleWith(1, Number.MAX_SAFE_INTEGER))
      .mockResolvedValueOnce(bundleWith(4, Number.MAX_SAFE_INTEGER))
    const deps = dependencies({ openRelay, readBundle })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(openRelay).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(openRelay).toHaveBeenCalledTimes(2)
    expect(openRelay).toHaveBeenLastCalledWith(
      relay,
      expect.objectContaining({ version: 1 }),
      expect.any(String)
    )
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('does not churn relay sessions off the cell attach-reservation deadline', async () => {
    // Why: the relay-hello's leaseExpiresAt is a ~10s attach deadline. Keying
    // rotation off it replaced the session every second, killing any RPC
    // slower than the cycle (the field symptom: "Worktree list unavailable").
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('connected'))
    // Direct stays unreachable, as in the field — return probes must not
    // confuse the churn measurement by migrating back to direct.
    const openDirect = vi.fn(() => new FakeSession('disconnected'))
    const deps = dependencies({ openRelay, openDirect })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(openRelay).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(openRelay).toHaveBeenCalledOnce()
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('recovers immediately on a background/foreground cycle after an E2EE rejection', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi
      .fn()
      .mockReturnValueOnce(
        new FakeRelaySession('disconnected', new MobileE2EEAuthenticationError())
      )
      .mockImplementation(() => new FakeRelaySession('connected'))
    const deps = dependencies({ openRelay })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(openRelay).toHaveBeenCalledOnce()

    supervisor.setForeground(false)
    supervisor.setForeground(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(openRelay).toHaveBeenCalledTimes(2)
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('restarts Relay promptly after the background grace expires', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const deps = dependencies({ openDirect: vi.fn(() => new FakeSession('disconnected')) })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    expect(deps.openRelay).not.toHaveBeenCalled()

    supervisor.setForeground(false)
    expect(logical.getState()).toBe('connected')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(logical.getState()).toBe('disconnected')
    expect(logical.getPendingPath()).toBeNull()

    supervisor.setForeground(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(deps.openRelay).toHaveBeenCalledOnce()
    expect(logical.getState()).toBe('connected')
    expect(logical.getPendingPath()).toBeNull()
    supervisor.stop()
  })

  it('recovers an expired background Relay through the app-resume manual retry nudge', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const deps = dependencies({ openDirect: vi.fn(() => new FakeSession('disconnected')) })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    supervisor.setForeground(false)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(logical.getState()).toBe('disconnected')

    supervisor.nudge('app-resume')
    await vi.advanceTimersByTimeAsync(0)

    expect(deps.openRelay).toHaveBeenCalledOnce()
    expect(logical.getActivePath()).toBe('relay')
    expect(logical.getState()).toBe('connected')
    expect(logical.getPendingPath()).toBeNull()
    supervisor.stop()
  })
})

// The field failure's first symptom: a real direct rpc-client dialing an
// unroutable LAN endpoint (instant 1006) while relay credentials sit unused.
class DeadSocket {
  static constructed: string[] = []
  onopen: (() => void) | null = null
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  readyState = 0

  constructor(readonly url: string) {
    DeadSocket.constructed.push(url)
    setTimeout(() => {
      this.readyState = 3
      this.onclose?.({ code: 1006, reason: '' })
    }, 50)
  }

  send(): void {}
  close(): void {
    this.readyState = 3
  }
}

describe('failover with a real direct rpc-client', () => {
  beforeEach(() => {
    DeadSocket.constructed = []
    vi.stubGlobal('WebSocket', DeadSocket)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-02T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('migrates the logical client to relay after the direct dial fails', async () => {
    const logical = createStableLogicalRpcClient(
      connect(DIRECT_ENDPOINT, host.deviceToken, host.publicKeyB64),
      'tailscale' as MobileConnectionPath
    )
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(3_000)

    expect(deps.openRelay).toHaveBeenCalled()
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
    logical.close()
  })

  it('reaches relay even when the bundle read settles after the first direct failure', async () => {
    const logical = createStableLogicalRpcClient(
      connect(DIRECT_ENDPOINT, host.deviceToken, host.publicKeyB64),
      'tailscale' as MobileConnectionPath
    )
    const deps = dependencies({
      readBundle: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200))
        return bundleWith(2, Number.MAX_SAFE_INTEGER)
      })
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    const started = supervisor.start()
    await vi.advanceTimersByTimeAsync(300)
    await started
    await vi.advanceTimersByTimeAsync(3_000)

    expect(deps.openRelay).toHaveBeenCalled()
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
    logical.close()
  })
})
