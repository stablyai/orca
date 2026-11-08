import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect, type RpcClient } from './rpc-client'
import {
  createStableLogicalRpcClient,
  type MobileConnectionPath
} from './stable-logical-rpc-client'

import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import type { MobileRelayRpcSession } from './relay/mobile-relay-rpc-session'
import { RelayDialStageTracker, type RelayDialStage } from './relay/relay-dial-stage'
import {
  MobileEndpointSupervisor,
  type MobileEndpointSupervisorDependencies
} from './mobile-endpoint-supervisor'
import type { ConnectionState, HostProfile, RpcResponse } from './types'

// Exercise relay-paired phones with unreachable direct endpoints so LAN retry cannot starve relay recovery.

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }))
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked'
}))
vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length)
}))

vi.mock('./encryption/e2ee', () => ({
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
  // Use realistic lease deadlines; fake values concealed latch, churn and timer-overflow defects.
  getAttachDeadlineAt = () => Date.now() + 10_000
  readonly dialStage = new RelayDialStageTracker()
  getDialStage = () => this.dialStage.getDialStage()
  onDialStageChange = (listener: (stage: RelayDialStage) => void) =>
    this.dialStage.onDialStageChange(listener)
  getResumeExpiresAt = () => Date.now() + 30 * 24 * 3_600_000
  getResumeConfirmation = () => null
  getFailure = () => this.failure
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
    setRelayRouting: vi.fn(async () => {}),
    lastGoodPathWasDirectHere: vi.fn(async () => true),
    recordGoodPath: vi.fn(async () => {}),
    readLocalNetwork: vi.fn(async () => null),
    directPath: 'lan',
    directProbeTimeoutMs: 4_000,
    now: Date.now,
    randomBytes: (length: number) => new Uint8Array(length),
    setTimer: (handler, ms) => setTimeout(handler, ms),
    clearTimer: (handle) => clearTimeout(handle),
    ...overrides
  }
}

// Use the real direct client against a dead LAN to ensure stored relay credentials drive recovery.
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
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(3_000)

    expect(DeadSocket.constructed).toContain(DIRECT_ENDPOINT)
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
    const supervisor = new MobileEndpointSupervisor(logical, host.id, relay, deps)

    const started = supervisor.start()
    await vi.advanceTimersByTimeAsync(300)
    await started
    await vi.advanceTimersByTimeAsync(3_000)

    expect(DeadSocket.constructed).toContain(DIRECT_ENDPOINT)
    expect(deps.openRelay).toHaveBeenCalled()
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
    logical.close()
  })
})
