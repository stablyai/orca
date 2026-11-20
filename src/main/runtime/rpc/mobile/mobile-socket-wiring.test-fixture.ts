import nacl from 'tweetnacl'
import type { WebSocket } from 'ws'
import { expect, vi, type Mock } from 'vitest'
import type { DeviceRegistry } from '../server/pairing/device-registry'
import { SimulatedMobileE2EEV2Peer } from '../../mobile-cloud-relay/testing/simulated-mobile-e2ee-v2-peer'
import { generateKeyPair } from '../../../../shared/remote-runtime/e2ee/node/e2ee-crypto'
import type { RpcBinarySender } from '../transports/rpc-binary-sender'
import {
  MobileSocketWiring,
  type AuthenticatedMobileSocket,
  type MobileSocketTransport,
  type MobileSocketTransportMetadata
} from './mobile-socket-wiring'

class FakeSocket {
  readonly OPEN = 1
  readyState = this.OPEN
  bufferedAmount = 0
  readonly sent: (string | Buffer)[] = []
  readonly send: Mock<(data: string | Buffer) => number> = vi.fn((data: string | Buffer) =>
    this.sent.push(data)
  )
  readonly close: Mock<(code?: number, reason?: string) => void> = vi.fn()
}

class FakeTransport implements MobileSocketTransport {
  private messageHandler: Parameters<MobileSocketTransport['onMessage']>[0] | null = null
  readonly setClientId: Mock<MobileSocketTransport['setClientId']> = vi.fn()
  readonly terminateClientConnections: Mock<MobileSocketTransport['terminateClientConnections']> =
    vi.fn(() => 0)
  onMessage(handler: Parameters<MobileSocketTransport['onMessage']>[0]): void {
    this.messageHandler = handler
  }
  onConnectionClose(): void {}
  receive(ws: FakeSocket, message: string): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wiring only sends, closes and reads OPEN/readyState/bufferedAmount.
    this.messageHandler?.(message, vi.fn(), ws as unknown as WebSocket)
  }
}

const desktop = generateKeyPair()

export type ReceivedRequest = {
  plaintext: string
  reply: (response: string) => void
  sendBinary: RpcBinarySender
}

/** Wiring over fake sockets; `connect` runs a direct (or `metadata`) v2 handshake and auth. */
export function mobileSocketHarness(
  registry: DeviceRegistry,
  metadata?: MobileSocketTransportMetadata
) {
  const transport = new FakeTransport()
  const ready: AuthenticatedMobileSocket[] = []
  const requests: ReceivedRequest[] = []
  const wiring = new MobileSocketWiring({
    deviceRegistry: registry,
    e2eeKeypair: {
      publicKey: desktop.publicKey,
      secretKey: desktop.secretKey,
      publicKeyB64: Buffer.from(desktop.publicKey).toString('base64')
    },
    onText: (_socket, plaintext, reply, sendBinary) =>
      requests.push({ plaintext, reply, sendBinary }),
    onBinary: vi.fn(),
    onClose: vi.fn(),
    onReady: (socket) => ready.push(socket)
  })
  wiring.attachTransport(transport, () => metadata ?? { transport: 'direct' })

  /** Opens a socket and sends `auth(transcriptHashB64)`; returns the decoded verdict. */
  function connect(auth: (transcriptHashB64: string) => Record<string, unknown>) {
    const ws = new FakeSocket()
    const peer = new SimulatedMobileE2EEV2Peer(
      nacl.box.keyPair(),
      desktop.publicKey,
      metadata?.transport === 'relay' ? metadata.relayHostId : null
    )
    transport.receive(ws, JSON.stringify(peer.hello))
    expect(peer.acceptReady(JSON.parse(String(ws.sent[0])))).toBe(true)
    const transcriptHashB64 = peer.transcriptHashB64
    transport.receive(
      ws,
      peer.sealText(
        JSON.stringify({ type: 'e2ee_auth', v: 2, transcriptHashB64, ...auth(transcriptHashB64) })
      )
    )
    const reply = ws.sent[1] ? JSON.parse(peer.openText(String(ws.sent[1]))!) : null
    /** Sends one application request over the authenticated socket. */
    const request = (plaintext: string): void => transport.receive(ws, peer.sealText(plaintext))
    return { ws, peer, transcriptHashB64, reply, socket: ready.at(-1), request }
  }
  return { connect, ready, requests }
}
