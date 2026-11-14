import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RelaySessionBrokerOptions } from './relay-session-broker-contract'
import { RelaySessionBroker } from './relay-session-broker'
import type * as RelayHttpClient from '../director/relay-http-client'

const http = vi.hoisted(() => ({
  exchangeRelayAuthorization: vi.fn(),
  requestRelayAssignment: vi.fn()
}))
const pool = vi.hoisted(() => ({ recovering: false, live: true }))

vi.mock('../../../power/system-power-lifecycle', () => ({
  subscribeSystemPowerLifecycle: () => () => {}
}))
vi.mock('../director/relay-http-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RelayHttpClient>()),
  exchangeRelayAuthorization: http.exchangeRelayAuthorization,
  requestRelayAssignment: http.requestRelayAssignment
}))
vi.mock('../origin-lifecycle/relay-origin-pool', () => ({
  RelayOriginPool: class {
    activeAssignment = { v: 1, cellUrl: 'https://relay-c1.example', assignmentEpoch: 1, lease: 'l' }
    openInitial = vi.fn(async () => {})
    refreshAuthorization = vi.fn()
    closeNow = vi.fn()
    hasLiveControl = () => pool.live
    isRecovering = () => pool.recovering
  }
}))

const HOUR = 60 * 60_000

function brokerOptions(overrides: Partial<RelaySessionBrokerOptions>): RelaySessionBrokerOptions {
  return {
    authConfig: {
      apiBaseUrl: 'https://api.example',
      authorizeEndpoint: 'https://api.example/authorize',
      sessionEndpoint: 'https://api.example/session',
      refreshEndpoint: 'https://api.example/refresh',
      capabilitiesEndpoint: 'https://api.example/capabilities',
      profileEndpoint: 'https://api.example/profile',
      orgEndpoint: 'https://api.example/org',
      logoutEndpoint: 'https://api.example/logout',
      relayTokenEndpoint: 'https://api.example/relay-token',
      connectorTokenEndpoint: 'https://api.example/connector-token',
      relayDirectorUrl: 'https://relay.example',
      clientId: 'client',
      scope: 'openid'
    },
    accessToken: 'access',
    identity: { userId: 'u', profileId: 'p', organizationId: 'o' },
    keypair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32), publicKeyB64: '' },
    appVersion: '1.0.0',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the origin pool that reads the wiring is mocked.
    mobileSocketWiring: {} as unknown as RelaySessionBrokerOptions['mobileSocketWiring'],
    isCurrent: () => true,
    refreshAccessToken: async () => ({ accessToken: 'access-2' }),
    onStatus: vi.fn(),
    random: () => 0.5,
    ...overrides
  }
}

describe('RelaySessionBroker recovery signals', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    pool.recovering = false
    pool.live = true
    http.exchangeRelayAuthorization.mockResolvedValue({
      relayToken: 'relay-jwt',
      expiresAt: Date.now() + HOUR
    })
    http.requestRelayAssignment.mockResolvedValue({
      v: 1,
      cellUrl: 'https://relay-c1.example',
      assignmentEpoch: 1,
      lease: 'l'
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('tells its owner when it closes itself after token refresh gives up', async () => {
    const onSelfClose = vi.fn()
    const refreshAccessToken = vi.fn(async () => {
      throw new Error('api unreachable')
    })
    const broker = await RelaySessionBroker.connect(
      brokerOptions({ onSelfClose, refreshAccessToken })
    )
    // Renewal fires before expiry, then retries every 5-15s until expiry + 60s.
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(refreshAccessToken).toHaveBeenCalled()
    expect(onSelfClose).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(80_000)
    expect(onSelfClose).toHaveBeenCalledTimes(1)
    expect(broker.isLive()).toBe(false)
  })

  it('does not report an owner-initiated close', async () => {
    const onSelfClose = vi.fn()
    const broker = await RelaySessionBroker.connect(brokerOptions({ onSelfClose }))
    broker.closeNow()
    expect(onSelfClose).not.toHaveBeenCalled()
  })

  it('counts as recovering only while open and its pool retries', async () => {
    const broker = await RelaySessionBroker.connect(brokerOptions({}))
    pool.live = false
    expect(broker.isRecovering()).toBe(false)
    pool.recovering = true
    expect(broker.isRecovering()).toBe(true)
    broker.closeNow()
    expect(broker.isRecovering()).toBe(false)
  })
})
