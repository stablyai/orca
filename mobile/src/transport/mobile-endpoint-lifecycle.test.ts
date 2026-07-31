import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ConnectionState, HostProfile, RpcResponse } from './types'
import type { RpcClient } from './rpc-client'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  readBundle: vi.fn()
}))

vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))
vi.mock('./rpc-client', () => ({ connect: (...args: unknown[]) => mocks.connect(...args) }))
vi.mock('./mobile-relay-credential-bundle', () => ({
  readMobileRelayCredentialBundle: (...args: unknown[]) => mocks.readBundle(...args),
  writeMobileRelayCredentialBundle: vi.fn(async () => {}),
  deleteMobileRelayCredentialBundle: vi.fn(async () => {})
}))
vi.mock('./mobile-relay-rpc-session', () => ({ connectMobileRelayRpcSession: vi.fn() }))
vi.mock('./mobile-relay-resume-director', () => ({
  resolveMobileRelayEndpoint: vi.fn()
}))
vi.mock('./host-store', () => ({
  saveExistingHostRelayUpgrade: vi.fn(async () => {}),
  updateHostLastGoodEndpoint: vi.fn(async () => {})
}))
vi.mock('./mobile-relay-direct-upgrade', () => ({ upgradeDirectMobileRelay: vi.fn() }))

import { startMobileEndpointLifecycle } from './mobile-endpoint-lifecycle'

function fakeRpcClient(state: ConnectionState): RpcClient {
  return {
    sendRequest: vi.fn(async (): Promise<RpcResponse> => {
      throw new Error('not implemented')
    }),
    subscribe: vi.fn(() => () => {}),
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => state,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: vi.fn(() => () => {}),
    notifyForeground: vi.fn(),
    close: vi.fn()
  }
}

function fakeLogicalClient(): StableLogicalRpcClient {
  return {
    ...fakeRpcClient('connected'),
    migrateTo: vi.fn(async () => {}),
    suspendActiveSession: vi.fn(),
    getActivePath: () => 'relay',
    setActivePath: vi.fn(),
    publishRouteOwnerState: vi.fn(),
    getGeneration: () => 1
  }
}

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 1,
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
    version: 1,
    expiresAt: Number.MAX_SAFE_INTEGER
  }
}

describe('mobile endpoint lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.connect.mockReset()
    mocks.readBundle.mockReset().mockResolvedValue(bundle)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens one non-reconnecting physical client for a failed legacy direct probe', async () => {
    const failedProbe = fakeRpcClient('disconnected')
    const onLog = vi.fn()
    mocks.connect.mockReturnValue(failedProbe)

    const lifecycle = startMobileEndpointLifecycle(fakeLogicalClient(), host, onLog)
    await Promise.resolve()
    await Promise.resolve()

    await vi.advanceTimersByTimeAsync(15_000)
    expect(mocks.connect).toHaveBeenCalledOnce()
    expect(mocks.connect).toHaveBeenCalledWith(host.endpoint, host.deviceToken, host.publicKeyB64, {
      onLog,
      autoReconnect: false
    })

    await vi.advanceTimersByTimeAsync(12_000)
    expect(mocks.connect).toHaveBeenCalledOnce()
    expect(failedProbe.close).toHaveBeenCalledOnce()
    lifecycle.stop()
  })
})
