import { beforeEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import type { RelayConnectionOpenMessage, RelayHostHelloAckMessage } from './relay-control-protocol'
import type { RelayAssignment } from './relay-http-client'

const fakes = vi.hoisted(() => ({
  controls: [] as { closeNow: ReturnType<typeof vi.fn> }[],
  setGeneration: vi.fn(),
  controlConnect: vi.fn()
}))

vi.mock('./relay-control-client', () => ({
  RelayControlClient: class {
    connect = fakes.controlConnect
    closeNow = vi.fn()
    isLive = vi.fn(() => true)
    pendingRequestCount = 0
    constructor(readonly options: unknown) {
      fakes.controls.push(this)
    }
  }
}))

vi.mock('../rpc/relay-transport', () => ({
  CloudRelayTransport: class {
    start = vi.fn().mockResolvedValue(undefined)
    stop = vi.fn().mockResolvedValue(undefined)
    setGeneration = fakes.setGeneration
    metadataFor = vi.fn()
    hasConnection = vi.fn(() => false)
    openConnection = vi.fn(async (_c: RelayConnectionOpenMessage) => {})
  }
}))

import { RelayControlOrigin } from './relay-control-origin'

const ASSIGNMENT: RelayAssignment = {
  v: 1,
  cellUrl: 'https://relay.example.test',
  assignmentEpoch: 1,
  lease: 'lease-token'
}

function ack(overrides: Partial<RelayHostHelloAckMessage> = {}): RelayHostHelloAckMessage {
  return {
    type: 'host-hello-ack',
    v: 1,
    generation: 7,
    controlResumeSecret: 'R'.repeat(43),
    leaseExpiresAt: 1_000_000,
    activeConnIds: [],
    pendingConns: [],
    ...overrides
  }
}

function createOrigin(): RelayControlOrigin {
  const keypair = nacl.box.keyPair()
  return new RelayControlOrigin({
    assignment: ASSIGNMENT,
    relayJwt: 'relay-jwt',
    relayHostId: 'host-1',
    identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
    keypair: { ...keypair, publicKeyB64: Buffer.from(keypair.publicKey).toString('base64') },
    appVersion: '1.0.0',
    mobileSocketWiring: { attachTransport: vi.fn(() => () => {}) } as never,
    onConnectionOwned: vi.fn(),
    onConnectionReleased: vi.fn(),
    onDrain: vi.fn(),
    onClose: vi.fn()
  })
}

describe('RelayControlOrigin rebind activation failure', () => {
  beforeEach(() => {
    fakes.controls.length = 0
    fakes.controlConnect.mockReset()
    fakes.setGeneration.mockReset()
  })

  it('closes the freshly opened control when the transport refuses the new generation', async () => {
    fakes.controlConnect
      .mockResolvedValueOnce(ack())
      // The cell could not resume: it hands back a fresh generation instead.
      .mockResolvedValueOnce(ack({ generation: 9, leaseExpiresAt: 2_000_000 }))
    fakes.setGeneration.mockImplementation((generation: number) => {
      // Mirrors CloudRelayTransport: a generation change is illegal while data
      // sockets are attached.
      if (generation !== 7) {
        throw new Error('invalid_relay_generation_transition')
      }
    })

    const origin = createOrigin()
    await origin.open()
    expect(fakes.controls).toHaveLength(1)

    await expect(origin.rebind('relay-jwt', ASSIGNMENT)).rejects.toThrow(
      'invalid_relay_generation_transition'
    )

    expect(fakes.controls).toHaveLength(2)
    expect(fakes.controls[1]!.closeNow).toHaveBeenCalled()
    expect(fakes.controls[0]!.closeNow).not.toHaveBeenCalled()
  })
})
