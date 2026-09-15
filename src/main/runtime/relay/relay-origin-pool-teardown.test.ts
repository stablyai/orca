import { beforeEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import type { OrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
import type { RelayHostHelloAckMessage } from './relay-control-protocol'
import type * as RelayHttpClientModule from './relay-http-client'

const fakes = vi.hoisted(() => ({
  controls: [] as {
    options: {
      onDrain(message: { type: 'drain'; graceMs: number; recovery: 'resolve-director' }): void
      onClose(code: number): void
    }
  }[],
  controlConnect: vi.fn(),
  exchange: vi.fn(),
  assign: vi.fn()
}))

vi.mock('./relay-http-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RelayHttpClientModule>()),
  exchangeRelayAuthorization: fakes.exchange,
  requestRelayAssignment: fakes.assign
}))

vi.mock('./relay-control-client', () => ({
  RelayControlClient: class {
    connect = fakes.controlConnect
    closeNow = vi.fn()
    isLive = vi.fn(() => true)
    pendingRequestCount = 0
    constructor(readonly options: (typeof fakes.controls)[number]['options']) {
      fakes.controls.push(this)
    }
  }
}))

vi.mock('../rpc/relay-transport', () => ({
  CloudRelayTransport: class {
    start = vi.fn().mockResolvedValue(undefined)
    stop = vi.fn().mockResolvedValue(undefined)
    setGeneration = vi.fn()
    metadataFor = vi.fn()
    hasConnection = vi.fn(() => false)
    openConnection = vi.fn().mockResolvedValue(undefined)
  }
}))

import { RelaySessionBroker } from './relay-session-broker'

function brokerOptions(
  overrides: Partial<Parameters<typeof RelaySessionBroker.connect>[0]> = {}
): Parameters<typeof RelaySessionBroker.connect>[0] {
  const keypair = nacl.box.keyPair()
  return {
    authConfig: {
      relayTokenEndpoint: 'https://auth.example.test/v1/relay-token',
      relayDirectorUrl: 'https://relay.example.test'
    } as OrcaCloudAuthConfig,
    accessToken: 'access-token',
    identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
    keypair: { ...keypair, publicKeyB64: Buffer.from(keypair.publicKey).toString('base64') },
    appVersion: '1.0.0',
    mobileSocketWiring: { attachTransport: vi.fn(() => () => {}) } as never,
    isCurrent: () => true,
    refreshAccessToken: async () => null,
    onStatus: vi.fn(),
    now: () => 0,
    random: () => 0.5,
    ...overrides
  }
}

describe('RelayOriginPool teardown', () => {
  beforeEach(() => {
    fakes.controls.length = 0
    fakes.controlConnect.mockReset()
    fakes.exchange.mockReset().mockResolvedValue({ relayToken: 'relay-jwt', expiresAt: 1_000_000 })
    fakes.assign.mockReset()
  })

  it('disarms the drain retry so no timer survives closeNow', async () => {
    vi.useFakeTimers()
    try {
      const ack: RelayHostHelloAckMessage = {
        type: 'host-hello-ack',
        v: 1,
        generation: 1,
        controlResumeSecret: 'R'.repeat(43),
        leaseExpiresAt: 1_000_000,
        activeConnIds: [],
        pendingConns: []
      }
      fakes.controlConnect.mockResolvedValue(ack)
      fakes.assign
        .mockResolvedValueOnce({
          cellUrl: 'https://relay.example.test',
          assignmentEpoch: 1,
          leaseExpiresAt: 1_000_000
        })
        .mockRejectedValue(new Error('director_unavailable'))

      const broker = await RelaySessionBroker.connect(brokerOptions())
      fakes.controls[0]!.options.onDrain({
        type: 'drain',
        graceMs: 5_000,
        recovery: 'resolve-director'
      })
      // The director refusal arms the drain retry.
      await vi.advanceTimersByTimeAsync(0)
      const armedWhileLive = vi.getTimerCount()
      expect(armedWhileLive).toBeGreaterThan(0)

      broker.closeNow()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
