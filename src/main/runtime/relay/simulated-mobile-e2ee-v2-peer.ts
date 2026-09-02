import nacl from 'tweetnacl'
import {
  encodeMobileE2EEV2Transcript,
  validateMobileE2EEV2Handshake,
  type MobileE2EEPayloadKind,
  type MobileE2EEV2Hello
} from '../../../shared/mobile-e2ee-v2-contract'
import {
  openMobileE2EEV2Frame,
  sealMobileE2EEV2Frame
} from '../../../shared/mobile-e2ee-v2-framing'
import { deriveSharedKey } from '../rpc/e2ee-crypto'
import { deriveMobileE2EEV2KeySchedule } from '../rpc/mobile-e2ee-v2-key-schedule'

// Why: the relay integration test needs an independent mobile-side wire peer
// without importing Expo modules into the desktop Node TypeScript project.
export class SimulatedMobileE2EEV2Peer {
  readonly hello: MobileE2EEV2Hello
  private inboundCounter = 0n
  private outboundCounter = 0n
  private schedule: ReturnType<typeof deriveMobileE2EEV2KeySchedule> | null = null

  constructor(
    private readonly clientKeys: nacl.BoxKeyPair,
    private readonly desktopPublicKey: Uint8Array,
    relayHostId: string,
    clientNonce = nacl.randomBytes(32)
  ) {
    this.hello = {
      type: 'e2ee_hello',
      v: 2,
      clientPublicKeyB64: Buffer.from(clientKeys.publicKey).toString('base64'),
      clientNonceB64: Buffer.from(clientNonce).toString('base64'),
      capabilities: { framing: [2], payloadKinds: ['text', 'binary'] },
      context: {
        protocol: 'orca-mobile-e2ee',
        initiator: 'mobile',
        responder: 'desktop',
        transport: 'relay',
        relayHostId
      }
    }
  }

  acceptReady(value: unknown): boolean {
    const handshake = validateMobileE2EEV2Handshake(this.hello, value)
    if (!handshake || !nacl.verify(handshake.desktopPublicKey, this.desktopPublicKey)) {
      return false
    }
    this.schedule = deriveMobileE2EEV2KeySchedule({
      sharedSecret: deriveSharedKey(this.clientKeys.secretKey, this.desktopPublicKey),
      transcript: encodeMobileE2EEV2Transcript(handshake),
      clientNonce: handshake.clientNonce,
      desktopNonce: handshake.desktopNonce
    })
    return true
  }

  get transcriptHashB64(): string {
    return Buffer.from(this.requireSchedule().transcriptHash).toString('base64')
  }

  sealText(plaintext: string): string {
    return Buffer.from(this.seal(new TextEncoder().encode(plaintext), 'text')).toString('base64')
  }

  sealBinary(plaintext: Uint8Array): Uint8Array {
    return this.seal(plaintext, 'binary')
  }

  openText(frameB64: string): string | null {
    const plaintext = this.open(Buffer.from(frameB64, 'base64'), 'text')
    return plaintext ? new TextDecoder().decode(plaintext) : null
  }

  openBinary(frame: Uint8Array): Uint8Array | null {
    return this.open(frame, 'binary')
  }

  private seal(payload: Uint8Array, payloadKind: MobileE2EEPayloadKind): Uint8Array {
    const schedule = this.requireSchedule()
    const frame = sealMobileE2EEV2Frame({
      payload,
      key: schedule.mobileToDesktopKey,
      sessionId: schedule.sessionId,
      direction: 'mobile-to-desktop',
      payloadKind,
      counter: this.outboundCounter
    })
    this.outboundCounter++
    return frame
  }

  private open(frame: Uint8Array, payloadKind: MobileE2EEPayloadKind): Uint8Array | null {
    const schedule = this.requireSchedule()
    const plaintext = openMobileE2EEV2Frame({
      frame,
      key: schedule.desktopToMobileKey,
      sessionId: schedule.sessionId,
      direction: 'desktop-to-mobile',
      payloadKind,
      expectedCounter: this.inboundCounter
    })
    if (plaintext) {
      this.inboundCounter++
    }
    return plaintext
  }

  private requireSchedule(): ReturnType<typeof deriveMobileE2EEV2KeySchedule> {
    if (!this.schedule) {
      throw new Error('Simulated mobile peer has not accepted E2EE ready')
    }
    return this.schedule
  }
}
