import { vi } from 'vitest'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import type { MobileRelayRpcSession } from './mobile-relay-rpc-session'
import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor'
import type { RpcClient } from './rpc-client'
import type { MobileConnectionPath, StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ConnectionState, HostProfile, RpcResponse } from './types'

export class FakeSession implements RpcClient {
  readonly sendRequest = vi.fn(
    async (_method: string, _params?: unknown): Promise<RpcResponse> => ({
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

export class FakeRelaySession extends FakeSession implements MobileRelayRpcSession {
  constructor(
    state: ConnectionState,
    private readonly failure: Error | null = null,
    private readonly resumeExpiry = Date.now() + 30 * 24 * 3_600_000,
    private readonly renewed = true
  ) {
    super(state)
  }
  // Why: production-realistic defaults — fictional fake values hid three
  // live defects in this subsystem (latch, churn, int32 timer overflow).
  getAttachDeadlineAt = () => Date.now() + 10_000
  getResumeExpiresAt = () => this.resumeExpiry
  getResumeConfirmation = () => ({
    v: 1 as const,
    reqId: 'confirm-1',
    currentVersion: 2,
    acceptedAs: this.renewed ? ('current' as const) : ('grace' as const),
    renewed: this.renewed,
    resumeExpiresAt: this.resumeExpiry
  })
  getFailure = () => this.failure
}

export class FakeLogicalClient extends FakeSession implements StableLogicalRpcClient {
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

export const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
}
export const host: HostProfile = {
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
export const bundle: MobileRelayCredentialBundle = {
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

export function dependencies(
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

export function mockCredentialRotation(logical: FakeLogicalClient): void {
  let installResult: Record<string, unknown> | null = null
  logical.sendRequest.mockImplementation(async (method, params) => {
    const request = params as { installReqId?: string; reqId?: string }
    if (method === 'pairing.provisionRelay') {
      installResult = {
        v: 1,
        reqId: request.reqId,
        authorizationMode: 'authenticated-direct',
        currentVersion: 3,
        resumeExpiresAt: Date.now() + 300_000,
        graceExpiresAt: Date.now() + 60_000
      }
      return { id: 'rpc-2', ok: true, result: installResult, _meta: { runtimeId: 'runtime-1' } }
    }
    return {
      id: 'rpc-1',
      ok: true,
      result: {
        v: 1,
        relay,
        installStatus: installResult
          ? { v: 1, reqId: request.installReqId, state: 'committed', result: installResult }
          : { v: 1, reqId: request.installReqId, state: 'not-found' }
      },
      _meta: { runtimeId: 'runtime-1' }
    }
  })
}
