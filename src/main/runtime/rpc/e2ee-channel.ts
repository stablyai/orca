// Why: this channel keeps E2EE framing out of RPC handlers, which consume plaintext across transports.
import type { WebSocket } from 'ws'
import { deriveSharedKey, encrypt, decrypt, encryptBytes, decryptBytes } from './e2ee-crypto'
import {
  DesktopMobileE2EEV2Session,
  type DesktopMobileE2EEV2Context
} from './mobile-e2ee-v2-desktop-session'
import type { DesktopMobileE2EEV2OutboundItem as V2OutboundItem } from './mobile-e2ee-v2-desktop-outbound'
import { handleDesktopMobileE2EEV2Inbound } from './mobile-e2ee-v2-desktop-inbound'
import { authenticateMobileE2EE, decodeMobileE2EEPublicKey } from './mobile-e2ee-auth-validation'
import {
  isMobileE2EEBinaryPayloadWithinLimit,
  isMobileE2EEOutboundItemWithinLimit,
  isMobileE2EETextPayloadWithinLimit
} from './mobile-e2ee-outbound-admission'
import { parseRemoteRuntimeJsonText } from '../../../shared/remote-runtime-request-frames'
import type { MobileE2EEOutboundMemoryBudget } from './mobile-e2ee-outbound-memory-budget'
import { MobileE2EEDesktopOutboundOwner } from './mobile-e2ee-desktop-outbound-owner'

const HANDSHAKE_TIMEOUT_MS = 10_000
const MAX_CONSECUTIVE_DECRYPT_FAILURES = 5

export type E2EEChannelOptions = {
  serverSecretKey: Uint8Array
  resolveAuthenticatedDevice: (token: string) => E2EEAuthenticatedDevice | null
  onReady: (channel: E2EEChannel, device: E2EEAuthenticatedDevice) => void
  onError: (code: number, reason: string) => void
  transportContext?: DesktopMobileE2EEV2Context
  requireV2?: boolean
  outboundMemoryBudget?: MobileE2EEOutboundMemoryBudget
}

export type E2EEAuthenticatedDevice = {
  deviceId: string
  deviceToken: string
  scope: 'mobile' | 'runtime'
}

export class E2EEChannel {
  private state: 'awaiting_hello' | 'awaiting_auth' | 'ready' = 'awaiting_hello'
  private sharedKey: Uint8Array | null = null
  private consecutiveFailures = 0
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private readonly ws: WebSocket
  private readonly serverSecretKey: Uint8Array
  private readonly resolveAuthenticatedDevice: (token: string) => E2EEAuthenticatedDevice | null
  private readonly onReady: (channel: E2EEChannel, device: E2EEAuthenticatedDevice) => void
  private readonly onError: (code: number, reason: string) => void
  private readonly transportContext: DesktopMobileE2EEV2Context
  private readonly requireV2: boolean
  private readonly outbound: MobileE2EEDesktopOutboundOwner
  private v2Session: DesktopMobileE2EEV2Session | null = null
  // Why: the handler is set after readiness because its reply closure needs this channel's encryption state.
  private messageHandler:
    | ((
        plaintext: string,
        encryptedReply: (response: string) => void,
        encryptedBinaryReply: (response: Uint8Array<ArrayBufferLike>) => boolean | void
      ) => void)
    | null = null
  private binaryMessageHandler: ((plaintext: Uint8Array<ArrayBufferLike>) => void) | null = null

  deviceToken: string | null = null
  authenticatedDevice: E2EEAuthenticatedDevice | null = null

  constructor(ws: WebSocket, options: E2EEChannelOptions) {
    this.ws = ws
    this.serverSecretKey = options.serverSecretKey
    this.resolveAuthenticatedDevice = options.resolveAuthenticatedDevice
    this.onReady = options.onReady
    this.onError = options.onError
    this.transportContext = options.transportContext ?? { transport: 'direct' }
    this.requireV2 = options.requireV2 ?? false
    this.outbound = new MobileE2EEDesktopOutboundOwner(ws, options.outboundMemoryBudget)

    this.handshakeTimer = setTimeout(() => {
      this.onError(4002, 'E2EE handshake timeout')
    }, HANDSHAKE_TIMEOUT_MS)
  }

  onMessage(
    handler: (
      plaintext: string,
      encryptedReply: (response: string) => void,
      encryptedBinaryReply: (response: Uint8Array<ArrayBufferLike>) => boolean | void
    ) => void
  ): void {
    this.messageHandler = handler
  }

  onBinaryMessage(handler: (plaintext: Uint8Array<ArrayBufferLike>) => void): void {
    this.binaryMessageHandler = handler
  }

  handleRawMessage(raw: string | Uint8Array<ArrayBufferLike>): void {
    if (this.state === 'awaiting_hello') {
      if (typeof raw !== 'string') {
        this.onError(4001, 'Invalid handshake message')
        return
      }
      this.handleHello(raw)
      return
    }

    if (this.v2Session) {
      this.handleV2RawMessage(raw)
      return
    }
    const sharedKey = this.sharedKey
    if (!sharedKey) {
      return
    }

    if (typeof raw !== 'string') {
      const plaintextBytes = decryptBytes(raw, sharedKey)
      if (plaintextBytes === null) {
        this.trackDecryptFailure()
        return
      }
      this.consecutiveFailures = 0
      if (this.state !== 'ready') {
        this.onError(4001, 'Invalid binary message before authentication')
        return
      }
      this.binaryMessageHandler?.(plaintextBytes)
      return
    }

    const plaintext = decrypt(raw, sharedKey)
    if (plaintext === null) {
      this.trackDecryptFailure()
      return
    }

    this.consecutiveFailures = 0
    if (this.state === 'awaiting_auth') {
      this.handleAuth(plaintext)
      return
    }

    // Why: streaming emits can outlive destroy(), so late replies must not encrypt with a cleared key.
    const encryptedReply = (response: string) => {
      if (!this.sharedKey || this.ws.readyState !== this.ws.OPEN) {
        return
      }
      if (!isMobileE2EETextPayloadWithinLimit(response)) {
        this.onError(1013, 'Outbound reply buffer overflow')
        return
      }
      this.outbound.enqueueLegacyText(
        encrypt(response, this.sharedKey),
        () => Boolean(this.sharedKey),
        () => this.onError(1013, 'Outbound reply buffer overflow')
      )
    }
    const encryptedBinaryReply = (response: Uint8Array<ArrayBufferLike>): boolean => {
      if (!this.sharedKey || this.ws.readyState !== this.ws.OPEN) {
        return false
      }
      if (!isMobileE2EEBinaryPayloadWithinLimit(response)) {
        this.onError(1013, 'Outbound reply buffer overflow')
        return false
      }
      if (!this.outbound.canSend(response.byteLength + 40)) {
        return false
      }
      this.ws.send(Buffer.from(encryptBytes(response, this.sharedKey)), { binary: true })
      return true
    }
    this.messageHandler?.(plaintext, encryptedReply, encryptedBinaryReply)
  }

  private trackDecryptFailure(): void {
    // Why: a wrong key cannot recover on this socket; close so the client uses its bounded auth retry budget.
    if (this.state === 'awaiting_auth') {
      this.onError(4001, 'Unauthorized')
    } else if (++this.consecutiveFailures >= MAX_CONSECUTIVE_DECRYPT_FAILURES) {
      this.onError(4003, 'Too many decryption failures')
    }
  }

  private handleHello(raw: string): void {
    let hello: Record<string, unknown>
    try {
      hello = parseRemoteRuntimeJsonText(raw) as Record<string, unknown>
    } catch {
      this.onError(4001, 'Invalid handshake message')
      return
    }

    if (hello.type === 'e2ee_hello' && hello.v === 2) {
      const session = DesktopMobileE2EEV2Session.create({
        hello,
        serverSecretKey: this.serverSecretKey,
        expectedContext: this.transportContext
      })
      if (!session) {
        this.onError(4001, 'Invalid e2ee_hello v2')
        return
      }
      this.v2Session = session
      this.state = 'awaiting_auth'
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.send(JSON.stringify(session.ready))
      }
      return
    }

    if (this.requireV2) {
      this.onError(4001, 'E2EE v2 required')
      return
    }
    if (hello.type !== 'e2ee_hello' || typeof hello.publicKeyB64 !== 'string') {
      this.onError(4001, 'Invalid e2ee_hello')
      return
    }

    // Why: derive the shared key from our secret + client's public key.
    // Both sides compute the same shared secret via ECDH.
    const clientPublicKey = decodeMobileE2EEPublicKey(hello.publicKeyB64)
    if (!clientPublicKey) {
      this.onError(4001, 'Invalid public key')
      return
    }

    this.sharedKey = deriveSharedKey(this.serverSecretKey, clientPublicKey)
    this.state = 'awaiting_auth'

    // Why: send e2ee_ready as plaintext — the client needs it to know the
    // key exchange succeeded before it can send encrypted authentication.
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify({ type: 'e2ee_ready' }))
    }
  }

  private handleAuth(plaintext: string): void {
    const authentication = authenticateMobileE2EE({
      plaintext,
      v2Session: this.v2Session,
      resolveDevice: this.resolveAuthenticatedDevice
    })
    if (!authentication.ok) {
      this.sendEncryptedControl({ type: 'e2ee_error', error: { code: authentication.code } })
      this.onError(4001, authentication.code === 'bad_auth' ? 'Invalid e2ee_auth' : 'Unauthorized')
      return
    }
    const authenticatedDevice = authentication.device

    this.deviceToken = authenticatedDevice.deviceToken
    this.authenticatedDevice = authenticatedDevice
    this.state = 'ready'

    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }

    // Why: transport-bound identity checks must complete before the peer sees
    // authentication success; relay sockets additionally bind this context to
    // their immutable relayDeviceId in the resolver.
    this.onReady(this, authenticatedDevice)
    this.sendEncryptedControl(
      this.v2Session
        ? {
            type: 'e2ee_authenticated',
            v: 2,
            transcriptHashB64: this.v2Session.transcriptHashB64
          }
        : { type: 'e2ee_authenticated' }
    )
  }

  private handleV2RawMessage(raw: string | Uint8Array<ArrayBufferLike>): void {
    handleDesktopMobileE2EEV2Inbound({
      session: this.v2Session!,
      raw,
      awaitingAuth: this.state === 'awaiting_auth',
      onDecryptFailure: () => this.trackDecryptFailure(),
      onDecryptSuccess: () => (this.consecutiveFailures = 0),
      onAuth: (plaintext) => this.handleAuth(plaintext),
      onBinary: (plaintext) => this.binaryMessageHandler?.(plaintext),
      onText: (plaintext) =>
        this.messageHandler?.(
          plaintext,
          (response) => this.enqueueV2({ kind: 'text', plaintext: response }),
          (response) => this.enqueueV2({ kind: 'binary', plaintext: response })
        ),
      onProtocolError: () => this.onError(4001, 'Invalid binary message before authentication')
    })
  }

  private enqueueV2(item: V2OutboundItem): boolean {
    if (!this.v2Session || this.ws.readyState !== this.ws.OPEN) {
      return false
    }
    if (!isMobileE2EEOutboundItemWithinLimit(item)) {
      this.onError(1013, 'Outbound reply buffer overflow')
      return false
    }
    return this.outbound.enqueueV2(item, this.v2Session, () =>
      this.onError(1013, 'Outbound reply buffer overflow')
    )
  }

  private sendEncryptedControl(message: unknown): void {
    if (this.v2Session) {
      this.enqueueV2({ kind: 'text', plaintext: JSON.stringify(message) })
    } else if (this.ws.readyState === this.ws.OPEN && this.sharedKey) {
      const frame = encrypt(JSON.stringify(message), this.sharedKey)
      this.outbound.sendLegacyFrame(frame, () =>
        this.onError(1013, 'Outbound reply buffer overflow')
      )
    }
  }

  destroy(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
    this.sharedKey = null
    this.authenticatedDevice = null
    this.v2Session = null
    this.messageHandler = null
    this.binaryMessageHandler = null
    this.outbound.dispose()
  }
}
