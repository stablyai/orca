import { beforeEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import type { OrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
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
    openConnection = vi.fn().mockResolvedValue(undefined)

    constructor() {
      fakes.transports.push(this)
    }
  }
}))

import { RelaySessionBroker, StaleRelayBrokerError } from './relay-session-broker'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('RelaySessionBroker lifecycle ownership', () => {
  beforeEach(() => {
    fakes.controls.length = 0
    fakes.transports.length = 0
    fakes.controlConnect.mockReset()
    fakes.exchange.mockReset().mockResolvedValue({ relayToken: 'relay-jwt', expiresAt: 1_000_000 })
    fakes.assign.mockReset().mockResolvedValue({
      cellUrl: 'https://relay.example.test',
      assignmentEpoch: 1,
      leaseExpiresAt: 60_000
    })
  })

  it('closes partially opened resources without publishing stale state', async () => {
    const controlAck = deferred<RelayHostHelloAckMessage>()
    fakes.controlConnect.mockReturnValue(controlAck.promise)
    let current = true
    const statuses: string[] = []
    const keypair = nacl.box.keyPair()
    const detachTransport = vi.fn()
    const connecting = RelaySessionBroker.connect({
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
      mobileSocketWiring: { attachTransport: vi.fn(() => detachTransport) } as never,
      isCurrent: () => current,
      refreshAccessToken: async () => null,
      onStatus: (status) => statuses.push(status)
    })
    await vi.waitFor(() => expect(fakes.controls).toHaveLength(1))
    const transportStopped = deferred<void>()
    fakes.transports[0]!.stop.mockReturnValue(transportStopped.promise)
    current = false
    controlAck.resolve({
      type: 'host-hello-ack',
      v: 1,
      generation: 1,
      controlResumeSecret: 'A'.repeat(43),
      leaseExpiresAt: 1_000_000,
      activeConnIds: [],
      pendingConns: []
    })

    await expect(connecting).rejects.toBeInstanceOf(StaleRelayBrokerError)
    expect(fakes.controls[0]!.closeNow).toHaveBeenCalledOnce()
    expect(fakes.transports[0]!.stop).toHaveBeenCalledOnce()
    expect(detachTransport).not.toHaveBeenCalled()
    transportStopped.resolve(undefined)
    await vi.waitFor(() => expect(detachTransport).toHaveBeenCalledOnce())
    expect(statuses).toEqual(['connecting'])
  })

  it('activates a new origin while keeping basis-bound work on the drained origin', async () => {
    const firstAck: RelayHostHelloAckMessage = {
      type: 'host-hello-ack',
      v: 1,
      generation: 1,
      controlResumeSecret: 'A'.repeat(43),
      leaseExpiresAt: 1_000_000,
      activeConnIds: [],
      pendingConns: []
    }
    fakes.controlConnect.mockResolvedValueOnce(firstAck).mockResolvedValueOnce({
      ...firstAck,
      generation: 2,
      controlResumeSecret: 'B'.repeat(43)
    })
    fakes.assign
      .mockResolvedValueOnce({
        cellUrl: 'https://relay-c1.example.test',
        assignmentEpoch: 1,
        leaseExpiresAt: 1_000_000
      })
      .mockResolvedValueOnce({
        cellUrl: 'https://relay-c2.example.test',
        assignmentEpoch: 2,
        leaseExpiresAt: 2_000_000
      })
    const broker = await RelaySessionBroker.connect(brokerOptions({ onStatus: vi.fn() }))
    fakes.controls[0]!.options.onConnectionOpen({
      connId: 'old-basis',
      connTicket: 'T'.repeat(43),
      kind: 'resume',
      relayDeviceId: 'device-1',
      attachDeadlineMs: 1_000
    })
    expect(brokerBasisIds(broker)).toEqual(['old-basis'])
    fakes.controls[0]!.options.onDrain({
      type: 'drain',
      graceMs: 30_000,
      recovery: 'resolve-director'
    })
    await vi.waitFor(() => expect(fakes.controls).toHaveLength(2))

    expect(broker.endpoint?.cellUrl).toBe('https://relay-c2.example.test')
    expect(fakes.transports[0]!.openConnection).toHaveBeenCalledOnce()
    expect(brokerBasisIds(broker)).toEqual(['old-basis'])
    expect(fakes.controls[0]!.closeNow).not.toHaveBeenCalled()
    expect(fakes.transports[0]!.stop).not.toHaveBeenCalled()
    await broker.confirmResume('old-basis', 'confirm-1')
    expect(fakes.controls[0]!.confirmResume).toHaveBeenCalledWith('old-basis', 'confirm-1')
    await broker.installCredential(
      'device-1',
      { reqId: 'install-1', newResumeTokenHash: 'H'.repeat(43) },
      { mode: 'relay-basis', basisConnId: 'old-basis' }
    )
    expect(fakes.controls[0]!.installCredential).toHaveBeenCalledOnce()
  })

  it('rebinds the same process generation with its control resume secret', async () => {
    const ack: RelayHostHelloAckMessage = {
      type: 'host-hello-ack',
      v: 1,
      generation: 7,
      controlResumeSecret: 'R'.repeat(43),
      leaseExpiresAt: 1_000_000,
      activeConnIds: ['existing-basis'],
      pendingConns: []
    }
    fakes.controlConnect.mockResolvedValueOnce(ack).mockResolvedValueOnce({
      ...ack,
      leaseExpiresAt: 2_000_000
    })
    fakes.assign
      .mockResolvedValueOnce({
        cellUrl: 'https://relay.example.test',
        assignmentEpoch: 1,
        leaseExpiresAt: 1_000_000
      })
      .mockResolvedValueOnce({
        cellUrl: 'https://relay.example.test',
        assignmentEpoch: 1,
        leaseExpiresAt: 2_000_000
      })
    const broker = await RelaySessionBroker.connect(brokerOptions())
    expect(brokerBasisIds(broker)).toEqual(['existing-basis'])
    fakes.controls[0]!.options.onDrain({
      type: 'drain',
      graceMs: 5_000,
      recovery: 'resolve-director'
    })
    await vi.waitFor(() => expect(fakes.controls).toHaveLength(2))

    expect(fakes.transports).toHaveLength(1)
    expect(fakes.controls[1]!.options.previousGeneration).toBe(7)
    expect(fakes.controls[1]!.options.controlResumeSecret).toBe('R'.repeat(43))
    await vi.waitFor(() => expect(brokerBasisIds(broker)).toEqual(['existing-basis']))
    await broker.confirmResume('existing-basis', 'confirm-1')
    expect(fakes.controls[1]!.confirmResume).toHaveBeenCalledOnce()
  })

  it('opens a fresh same-cell generation when process-local rebind state is lost', async () => {
    const ack: RelayHostHelloAckMessage = {
      type: 'host-hello-ack',
      v: 1,
      generation: 7,
      controlResumeSecret: 'R'.repeat(43),
      leaseExpiresAt: 1_000_000,
      activeConnIds: [],
      pendingConns: []
    }
    fakes.controlConnect
      .mockResolvedValueOnce(ack)
      .mockRejectedValueOnce(new Error('relay_control_closed_4401'))
      .mockResolvedValueOnce({
        ...ack,
        generation: 1,
        controlResumeSecret: 'N'.repeat(43),
        leaseExpiresAt: 2_000_000
      })
    fakes.assign
      .mockResolvedValueOnce({
        cellUrl: 'https://relay.example.test',
        assignmentEpoch: 1,
        leaseExpiresAt: 1_000_000
      })
      .mockResolvedValueOnce({
        cellUrl: 'https://relay.example.test',
        assignmentEpoch: 1,
        leaseExpiresAt: 2_000_000
      })
    const onStatus = vi.fn()
    const broker = await RelaySessionBroker.connect(brokerOptions({ onStatus }))

    fakes.controls[0]!.options.onClose(1006)
    await vi.waitFor(() => expect(fakes.controls).toHaveLength(3))

    expect(fakes.controls[1]!.options.previousGeneration).toBe(7)
    expect(fakes.controls[1]!.options.controlResumeSecret).toBe('R'.repeat(43))
    expect(fakes.controls[2]!.options.previousGeneration).toBeUndefined()
    expect(fakes.controls[2]!.options.controlResumeSecret).toBeUndefined()
    expect(fakes.transports).toHaveLength(2)
    await vi.waitFor(() => expect(onStatus).toHaveBeenLastCalledWith('registered'))
    expect(broker.endpoint?.cellUrl).toBe('https://relay.example.test')
  })
})

function brokerBasisIds(broker: RelaySessionBroker): string[] {
  const pool = (broker as unknown as { originPool: unknown }).originPool
  return [...(pool as { basisOrigins: Map<string, unknown> }).basisOrigins.keys()]
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
    refreshAccessToken: async () => null,
    onStatus: vi.fn(),
    now: () => 0,
    random: () => 0,
    ...overrides
  }
}
