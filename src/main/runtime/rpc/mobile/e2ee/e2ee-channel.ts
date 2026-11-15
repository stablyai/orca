import type { E2EEChannelOptions, E2EEChannelTextHandler } from './e2ee-channel-options'
import type * as RpcBinary from '../../transports/rpc-binary-sender'
export type { E2EEChannelOptions } from './e2ee-channel-options'
// Keep E2EE framing outside transport-independent plaintext RPC handlers.
import type { WebSocket } from 'ws'
import { PAIRED_E2EE_HANDSHAKE_DEADLINE_MS } from '../../../../../shared/remote-runtime/e2ee/paired-e2ee-handshake-deadline'
import {
  deriveSharedKey,
  encrypt,
  decrypt,
  decryptBytes
} from '../../../../../shared/remote-runtime/e2ee/node/e2ee-crypto'
import {
  DesktopMobileE2EEV2Session,
  type DesktopMobileE2EEV2Context
} from './mobile-e2ee-v2-desktop-session'
import type { DesktopMobileE2EEV2OutboundItem as V2OutboundItem } from './mobile-e2ee-v2-desktop-outbound'
import { handleDesktopMobileE2EEV2Inbound } from './mobile-e2ee-v2-desktop-inbound'
import {
  authenticateMobileE2EE,
  decodeMobileE2EEPublicKey,
  describeMobileE2EEAuthFailure
} from './mobile-e2ee-auth-validation'
import {
  isMobileE2EEOutboundItemWithinLimit,
  trackMobileE2EEOutboundBudgetClose,
  type MobileE2EEOutboundBudgetEmitter
} from './mobile-e2ee-outbound-admission'
import { parseRemoteRuntimeJsonText } from '../../../../../shared/remote-runtime/requests/remote-runtime-request-frames'
import { MobileE2EEDesktopOutboundOwner } from './mobile-e2ee-desktop-outbound-owner'
import { createLegacyReplySenders } from './mobile-e2ee-legacy-reply-senders'
import { RuntimeClientCapabilities } from '../../callers/runtime-client-capabilities'
import type { E2EEAuthenticatedDevice } from '../../server/mobile-e2ee-authenticated-device'

const MAX_CONSECUTIVE_DECRYPT_FAILURES = 5

export class E2EEChannel {
  private state: 'awaiting_hello' | 'awaiting_auth' | 'ready' = 'awaiting_hello'
  private sharedKey: Uint8Array | null = null
  private consecutiveFailures = 0
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private readonly ws: WebSocket
  private readonly serverSecretKey: Uint8Array
  private readonly resolvers: Pick<
    E2EEChannelOptions,
    'resolveAuthenticatedDevice' | 'resolveAuthenticatedDeviceKey'
  >
  private readonly onReady: E2EEChannelOptions['onReady']
  private readonly onError: (code: number, reason: string) => void
  private readonly runAuthentication: (action: () => void) => void
  private readonly transportContext: DesktopMobileE2EEV2Context
  private readonly requireV2: boolean
  private readonly outbound: MobileE2EEDesktopOutboundOwner
  private v2Session: DesktopMobileE2EEV2Session | null = null
  // Install the handler after readiness so its reply closure has encryption state.
  private messageHandler: E2EEChannelTextHandler | null = null
  private binaryMessageHandler: ((plaintext: Uint8Array<ArrayBufferLike>) => void) | null = null

  deviceToken: string | null = null

  /** The v2 transcript this socket authenticated under; null on legacy framing. */
  get transcriptHashB64(): string | null {
    return this.v2Session?.transcriptHashB64 ?? null
  }
  authenticatedDevice: E2EEAuthenticatedDevice | null = null
  readonly capabilitySource = new RuntimeClientCapabilities()

  constructor(ws: WebSocket, options: E2EEChannelOptions) {
    this.ws = ws
    this.serverSecretKey = options.serverSecretKey
    this.resolvers = options
    this.onReady = options.onReady
    this.onError = options.onError
    this.runAuthentication = options.runAuthentication ?? ((action) => action())
    this.transportContext = options.transportContext ?? { transport: 'direct' }
    this.requireV2 = options.requireV2 ?? false
    this.outbound = new MobileE2EEDesktopOutboundOwner(
      ws,
      () => Boolean(this.sharedKey),
      () => this.closeForOutboundBudget('queue'),
      this.capabilitySource,
      options.outboundMemoryBudget
    )

    this.handshakeTimer = setTimeout(() => {
      this.onError(4002, 'E2EE handshake timeout')
    }, PAIRED_E2EE_HANDSHAKE_DEADLINE_MS)
  }

  onMessage(handler: E2EEChannelTextHandler): void {
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
      this.runAuthentication(() => this.authenticateAndReady(plaintext))
      return
    }

    const reply = createLegacyReplySenders({
      ws: this.ws,
      outbound: this.outbound,
      getSharedKey: () => this.sharedKey,
      onOversize: () => this.closeForOutboundBudget('size')
    })
    this.messageHandler?.(plaintext, reply.text, reply.binary)
  }

  private trackDecryptFailure(): void {
    // A wrong key cannot recover on this socket; closing invokes the client's bounded auth retry.
    if (this.state === 'awaiting_auth') {
      this.onError(4001, 'Unauthorized')
    } else if (++this.consecutiveFailures >= MAX_CONSECUTIVE_DECRYPT_FAILURES) {
      this.onError(4003, 'Too many decryption failures')
    }
  }

  private handleHello(raw: string): void {
    let hello: Record<string, unknown>
    try {
      const parsed = parseRemoteRuntimeJsonText(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.onError(4001, 'Invalid handshake message')
        return
      }
      hello = { ...parsed }
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

    // Derive the same ECDH shared secret on both peers.
    const clientPublicKey = decodeMobileE2EEPublicKey(hello.publicKeyB64)
    if (!clientPublicKey) {
      this.onError(4001, 'Invalid public key')
      return
    }

    this.sharedKey = deriveSharedKey(this.serverSecretKey, clientPublicKey)
    this.state = 'awaiting_auth'

    // Ready must be plaintext so the peer can begin encrypted authentication.
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify({ type: 'e2ee_ready' }))
    }
  }

  private authenticateAndReady(plaintext: string): void {
    const authenticate = () =>
      authenticateMobileE2EE({
        plaintext,
        v2Session: this.v2Session,
        v2TokenCapabilities: this.transportContext.transport === 'direct',
        resolveDevice: this.resolvers.resolveAuthenticatedDevice,
        resolveDeviceKey: this.resolvers.resolveAuthenticatedDeviceKey
      })
    const authentication = authenticate()
    if (!authentication.ok) {
      const failure = describeMobileE2EEAuthFailure(authentication)
      this.sendEncryptedControl(failure.sealedError)
      this.onError(4001, failure.closeReason)
      return
    }
    let authenticatedDevice = authentication.device

    this.capabilitySource.replace(authentication.clientCapabilities)
    const readiness = this.onReady(this, authenticatedDevice, authenticate)
    if (readiness?.ok === false) {
      const failure = describeMobileE2EEAuthFailure(readiness)
      this.sendEncryptedControl(failure.sealedError)
      this.onError(4001, failure.closeReason)
      return
    }
    if (readiness?.ok) {
      authenticatedDevice = readiness.device
    }
    this.deviceToken = authenticatedDevice.deviceToken ?? null
    this.authenticatedDevice = authenticatedDevice
    this.state = 'ready'
    clearTimeout(this.handshakeTimer ?? undefined)
    this.handshakeTimer = null
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
      onAuth: (text) => this.runAuthentication(() => this.authenticateAndReady(text)),
      onBinary: (plaintext) => this.binaryMessageHandler?.(plaintext),
      onText: (plaintext) =>
        this.messageHandler?.(
          plaintext,
          (response) => this.enqueueV2({ kind: 'text', plaintext: response }),
          (response, options) => this.enqueueV2({ kind: 'binary', plaintext: response }, options)
        ),
      onProtocolError: () => this.onError(4001, 'Invalid binary message before authentication')
    })
  }

  private enqueueV2(
    item: V2OutboundItem,
    options?: RpcBinary.RpcBinarySendOptions
  ): RpcBinary.RpcBinarySendResult {
    if (!this.v2Session || this.ws.readyState !== this.ws.OPEN) {
      return false
    }
    if (!isMobileE2EEOutboundItemWithinLimit(item)) {
      this.closeForOutboundBudget('size')
      return false
    }
    return this.outbound.enqueueV2(item, this.v2Session, options)
  }

  // Both budget closes kill the remote session: size identifies an oversized producer, queue a backed-up link.
  private closeForOutboundBudget(emitter: MobileE2EEOutboundBudgetEmitter): void {
    trackMobileE2EEOutboundBudgetClose(emitter)
    this.onError(1013, 'Outbound reply buffer overflow')
  }

  private sendEncryptedControl(message: unknown): void {
    if (this.v2Session) {
      this.enqueueV2({ kind: 'text', plaintext: JSON.stringify(message) })
    } else if (this.ws.readyState === this.ws.OPEN && this.sharedKey) {
      const frame = encrypt(JSON.stringify(message), this.sharedKey)
      this.outbound.sendLegacyFrame(frame)
    }
  }

  destroy(): void {
    this.capabilitySource.dispose()
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
