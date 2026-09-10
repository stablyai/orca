import { beforeEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import {
  RELAY_HOST_ATTACH_DEADLINE_MS,
  type RelayConnectionOpenMessage,
  type RelayHostHelloAckMessage
} from './relay-control-protocol'
import type { RelayAssignment } from './relay-http-client'

const fakes = vi.hoisted(() => ({
  controls: [] as {
    options: {
      previousGeneration?: number
      controlResumeSecret?: string
      onConnectionOpen(message: RelayConnectionOpenMessage): void
      onDrain(message: { type: 'drain'; graceMs: number; recovery: 'resolve-director' }): void
      onClose(code: number): void
    }
  }[],
  transports: [] as {
    openConnections: Set<string>
    openConnection: ReturnType<typeof vi.fn>
    hasConnection: ReturnType<typeof vi.fn>
  }[],
  controlConnect: vi.fn()
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
    readonly openConnections = new Set<string>()
    start = vi.fn().mockResolvedValue(undefined)
    stop = vi.fn().mockResolvedValue(undefined)
    setGeneration = vi.fn()
    metadataFor = vi.fn()
    hasConnection = vi.fn((connectionId: string) => this.openConnections.has(connectionId))
    openConnection = vi.fn(async (connection: RelayConnectionOpenMessage) => {
      this.openConnections.add(connection.connId)
    })

    constructor() {
      fakes.transports.push(this)
    }
  }
}))

import { RelayControlOrigin } from './relay-control-origin'

const ASSIGNMENT: RelayAssignment = {
  v: 1,
  cellUrl: 'https://relay.example.test',
  assignmentEpoch: 1,
  lease: 'lease-token'
}
const TICKET = 'T'.repeat(43)

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

function connOpen(overrides: Partial<RelayConnectionOpenMessage> = {}): RelayConnectionOpenMessage {
  return {
    type: 'conn-open',
    connId: 'conn-1',
    connTicket: TICKET,
    kind: 'resume',
    relayDeviceId: 'device-1',
    attachDeadlineMs: 10_000,
    ...overrides
  }
}

function createOrigin(): {
  origin: RelayControlOrigin
  owned: string[]
  released: string[]
} {
  const keypair = nacl.box.keyPair()
  const owned: string[] = []
  const released: string[] = []
  const origin = new RelayControlOrigin({
    assignment: ASSIGNMENT,
    relayJwt: 'relay-jwt',
    relayHostId: 'host-1',
    identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
    keypair: { ...keypair, publicKeyB64: Buffer.from(keypair.publicKey).toString('base64') },
    appVersion: '1.0.0',
    mobileSocketWiring: { attachTransport: vi.fn(() => () => {}) } as never,
    onConnectionOwned: (connectionId) => owned.push(connectionId),
    onConnectionReleased: (connectionId) => released.push(connectionId),
    onDrain: vi.fn(),
    onClose: vi.fn()
  })
  return { origin, owned, released }
}

describe('RelayControlOrigin pending-connection replay', () => {
  beforeEach(() => {
    fakes.controls.length = 0
    fakes.transports.length = 0
    fakes.controlConnect.mockReset()
  })

  it('pins the attach deadline this file mirrors from the relay contract', () => {
    // Hand-mirrored from RELAY_PROTOCOL_LIMITS.hostAttachDeadlineMs, which the
    // contract suite pins to the same literal. Drift would silently shorten the
    // observed-open eviction window and the deadline a replayed dial states.
    expect(RELAY_HOST_ATTACH_DEADLINE_MS).toBe(10_000)
  })

  it('dials a pending connection the ack restates in full, without waiting on a timer', async () => {
    fakes.controlConnect.mockResolvedValue(
      ack({
        pendingConns: [
          { connId: 'conn-1', connTicket: TICKET, kind: 'invite', relayDeviceId: 'device-1' }
        ]
      })
    )
    const { origin, owned } = createOrigin()

    await origin.open()

    expect(fakes.transports[0]!.openConnection).toHaveBeenCalledOnce()
    expect(fakes.transports[0]!.openConnection).toHaveBeenCalledWith({
      type: 'conn-open',
      connId: 'conn-1',
      connTicket: TICKET,
      kind: 'invite',
      relayDeviceId: 'device-1',
      attachDeadlineMs: 10_000
    })
    expect(owned).toEqual(['conn-1'])
  })

  it('replays a pending connection the relay only identified, reusing the observed conn-open', async () => {
    fakes.controlConnect
      .mockResolvedValueOnce(ack())
      .mockResolvedValueOnce(ack({ pendingConns: [{ connId: 'conn-1', connTicket: TICKET }] }))
    const { origin } = createOrigin()
    await origin.open()
    fakes.controls[0]!.options.onConnectionOpen(connOpen())
    // The blip that costs the control also kills the in-flight data socket.
    fakes.transports[0]!.openConnections.delete('conn-1')

    await origin.rebind('relay-jwt', ASSIGNMENT)

    expect(fakes.transports[0]!.openConnection).toHaveBeenCalledTimes(2)
    expect(fakes.transports[0]!.openConnection).toHaveBeenLastCalledWith({
      type: 'conn-open',
      connId: 'conn-1',
      connTicket: TICKET,
      kind: 'resume',
      relayDeviceId: 'device-1',
      attachDeadlineMs: 10_000
    })
  })

  it('never re-dials a pending connection that is already owned or open', async () => {
    fakes.controlConnect.mockResolvedValueOnce(ack()).mockResolvedValueOnce(
      ack({
        activeConnIds: ['conn-active'],
        pendingConns: [
          { connId: 'conn-active', connTicket: TICKET, kind: 'resume', relayDeviceId: 'device-1' },
          { connId: 'conn-1', connTicket: TICKET, kind: 'resume', relayDeviceId: 'device-1' }
        ]
      })
    )
    const { origin } = createOrigin()
    await origin.open()
    fakes.controls[0]!.options.onConnectionOpen(connOpen())
    expect(fakes.transports[0]!.openConnection).toHaveBeenCalledOnce()

    await origin.rebind('relay-jwt', ASSIGNMENT)

    // conn-active is spliced already and conn-1 still holds its data socket.
    expect(fakes.transports[0]!.openConnection).toHaveBeenCalledOnce()
  })

  it('skips a pending connection no control ever described', async () => {
    // Documents the contract gap: pendingConns entries carry only the
    // identifiers, and a dial without the relay's kind/device would guess at
    // both the pairing authority and the E2EE device binding.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fakes.controlConnect.mockResolvedValue(
      ack({ pendingConns: [{ connId: 'conn-unknown', connTicket: TICKET }] })
    )
    const { origin, owned } = createOrigin()

    await origin.open()

    expect(fakes.transports[0]!.openConnection).not.toHaveBeenCalled()
    expect(owned).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('dials nothing once the origin is closed', async () => {
    fakes.controlConnect.mockResolvedValue(ack())
    const { origin, owned } = createOrigin()
    await origin.open()
    await origin.close()

    // A conn-open still in flight when teardown ran must not open a data socket
    // that nothing is left to close.
    fakes.controls[0]!.options.onConnectionOpen(connOpen({ connId: 'conn-late' }))

    expect(fakes.transports[0]!.openConnection).not.toHaveBeenCalled()
    expect(owned).toEqual([])
  })

  it('releases a replayed connection whose dial fails', async () => {
    fakes.controlConnect.mockResolvedValue(
      ack({
        pendingConns: [
          { connId: 'conn-1', connTicket: TICKET, kind: 'resume', relayDeviceId: 'device-1' }
        ]
      })
    )
    const { origin, released } = createOrigin()
    fakes.transports[0]!.openConnection.mockRejectedValue(new Error('relay_transport_stopped'))

    await origin.open()

    await vi.waitFor(() => expect(released).toEqual(['conn-1']))
  })
})
