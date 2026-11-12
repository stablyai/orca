import { beforeEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import type { OrcaCloudAuthConfig } from '../../orca-profiles/cloud-auth/profile-cloud-auth-config'
import type { RelayHostHelloAckMessage } from './relay-control-protocol'
import type * as RelayHttpClientModule from './relay-http-client'

const fakes = vi.hoisted(() => ({
  controls: [] as {
    options: {
      onConnectionOpen(message: {
        connId: string
        connTicket: string
        kind: 'invite' | 'resume'
        relayDeviceId: string
        attachDeadlineMs: number
      }): void
      onDrain(message: { type: 'drain'; graceMs: number; recovery: 'resolve-director' }): void
      onClose(code: number): void
      previousGeneration?: number
      controlResumeSecret?: string
    }
    connect: ReturnType<typeof vi.fn>
    closeNow: ReturnType<typeof vi.fn>
    confirmResume: ReturnType<typeof vi.fn>
    installCredential: ReturnType<typeof vi.fn>
    pendingRequestCount: number
  }[],
  transports: [] as {
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    setGeneration: ReturnType<typeof vi.fn>
    metadataFor: ReturnType<typeof vi.fn>
    openConnection: ReturnType<typeof vi.fn>
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
    confirmResume = vi.fn().mockResolvedValue({
      type: 'device-resume-confirmed',
      v: 1,
      reqId: 'confirm-1',
      currentVersion: 1,
      acceptedAs: 'current',
      renewed: true,
      resumeExpiresAt: 100_000
    })
    installCredential = vi.fn().mockResolvedValue({
      type: 'device-credential-installed',
      v: 1,
      reqId: 'install-1',
      authorizationMode: 'relay-basis',
      currentVersion: 1,
      resumeExpiresAt: 100_000
    })
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

    constructor() {
      fakes.transports.push(this)
    }
  }
}))

import { RelaySessionBroker } from './relay-session-broker'
import './relay-session-broker-contract'
import './relay-http-client'
import './relay-auth-coordinator'

import '../../../shared/relay-host-close-reason'

describe('RelaySessionBroker lifecycle ownership', () => {
  beforeEach(() => {
    fakes.controls.length = 0
    fakes.transports.length = 0
    fakes.controlConnect.mockReset()
    fakes.exchange.mockReset().mockResolvedValue({ relayToken: 'relay-jwt', expiresAt: 1_000_000 })
    fakes.assign.mockReset().mockResolvedValue(relayAssignment('https://relay.example.test', 1))
  })

  it('recovers through a new origin after the director failure clears', async () => {
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
        .mockResolvedValueOnce(relayAssignment('https://relay-c1.example.test', 1))
        .mockRejectedValueOnce(new Error('director_unavailable'))
        .mockResolvedValueOnce(relayAssignment('https://relay-c2.example.test', 2))
      const broker = await RelaySessionBroker.connect(brokerOptions({ random: () => 0.5 }))

      fakes.controls[0]!.options.onDrain({
        type: 'drain',
        graceMs: 5_000,
        recovery: 'resolve-director'
      })
      await vi.advanceTimersByTimeAsync(499)
      expect(broker.endpoint?.cellUrl).toBe('https://relay-c1.example.test')
      await vi.advanceTimersByTimeAsync(1)
      expect(broker.endpoint?.cellUrl).toBe('https://relay-c2.example.test')
      expect(fakes.assign).toHaveBeenCalledTimes(3)
      broker.closeNow()
    } finally {
      vi.useRealTimers()
    }
  })
})

// Renewal can discover auth loss before the coordinator; its close must carry the reason.

function relayAssignment(
  cellUrl: string,
  assignmentEpoch: number
): RelayHttpClientModule.RelayAssignment {
  return { v: 1, cellUrl, assignmentEpoch, lease: 'assignment-lease' }
}

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
    keypair: {
      ...keypair,
      publicKeyB64: Buffer.from(keypair.publicKey).toString('base64')
    },
    appVersion: '1.0.0',
    mobileSocketWiring: { attachTransport: vi.fn(() => () => {}) } as never,
    isCurrent: () => true,
    refreshAccessToken: async () => ({ accessToken: null }),
    onStatus: vi.fn(),
    now: () => 0,
    random: () => 0,
    ...overrides
  }
}
