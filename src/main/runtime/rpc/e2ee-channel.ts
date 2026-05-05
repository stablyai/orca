// Why: the E2EE channel sits between the WebSocket transport and the RPC handler.
// It owns the handshake state machine and transparent encrypt/decrypt so the RPC
// handler only sees plaintext JSON, identical to the Unix socket path.
import type { WebSocket } from 'ws'
import { deriveSharedKey, encrypt, decrypt } from './e2ee-crypto'

type ChannelState = 'awaiting_hello' | 'awaiting_auth' | 'ready'

const HANDSHAKE_TIMEOUT_MS = 10_000
const MAX_CONSECUTIVE_DECRYPT_FAILURES = 5

type E2EEHello = {
  type: 'e2ee_hello'
  publicKeyB64: string
}

type E2EEAuth = {
  type: 'e2ee_auth'
  deviceToken: string
}

export type E2EEChannelOptions = {
  serverSecretKey: Uint8Array
  validateToken: (token: string) => boolean
  onReady: (channel: E2EEChannel) => void
  onError: (code: number, reason: string) => void
}

export class E2EEChannel {
  private state: ChannelState = 'awaiting_hello'
  private sharedKey: Uint8Array | null = null
  private consecutiveFailures = 0
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private readonly ws: WebSocket
  private readonly serverSecretKey: Uint8Array
  private readonly validateToken: (token: string) => boolean
  private readonly onReady: (channel: E2EEChannel) => void
  private readonly onError: (code: number, reason: string) => void
  // Why: the RPC handler is set after the channel is ready, so the channel
  // can forward decrypted messages. Kept as a callback rather than constructor
  // param because the handler needs the encrypt function for replies.
  private messageHandler:
    | ((plaintext: string, encryptedReply: (response: string) => void) => void)
    | null = null

  deviceToken: string | null = null

  constructor(ws: WebSocket, options: E2EEChannelOptions) {
    this.ws = ws
    this.serverSecretKey = options.serverSecretKey
    this.validateToken = options.validateToken
    this.onReady = options.onReady
    this.onError = options.onError

    this.handshakeTimer = setTimeout(() => {
      this.onError(4002, 'E2EE handshake timeout')
    }, HANDSHAKE_TIMEOUT_MS)
  }

  onMessage(
    handler: (plaintext: string, encryptedReply: (response: string) => void) => void
  ): void {
    this.messageHandler = handler
  }

  handleRawMessage(raw: string): void {
    if (this.state === 'awaiting_hello') {
      this.handleHello(raw)
      return
    }

    if (!this.sharedKey) {
      return
    }

    const plaintext = decrypt(raw, this.sharedKey)
    if (plaintext === null) {
      this.consecutiveFailures++
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_DECRYPT_FAILURES) {
        this.onError(4003, 'Too many decryption failures')
      }
      return
    }

    this.consecutiveFailures = 0
    if (this.state === 'awaiting_auth') {
      this.handleAuth(plaintext)
      return
    }

    // Why: streaming RPC handlers (e.g. terminal.subscribe) retain this
    // closure and may fire emits long after the inbound message handled
    // here. If destroy() runs in between (mobile disconnect, handshake
    // failure) sharedKey becomes null and tweetnacl throws "unexpected
    // type, use Uint8Array" from inside nacl.box.after. Guard both the
    // socket state AND the key so late emits become silent no-ops.
    const encryptedReply = (response: string) => {
      if (!this.sharedKey || this.ws.readyState !== this.ws.OPEN) {
        return
      }
      this.ws.send(encrypt(response, this.sharedKey))
    }
    this.messageHandler?.(plaintext, encryptedReply)
  }

  private handleHello(raw: string): void {
    let hello: E2EEHello
    try {
      hello = JSON.parse(raw) as E2EEHello
    } catch {
      this.onError(4001, 'Invalid handshake message')
      return
    }

    if (hello.type !== 'e2ee_hello' || !hello.publicKeyB64) {
      this.onError(4001, 'Invalid e2ee_hello')
      return
    }

    // Why: derive the shared key from our secret + client's public key.
    // Both sides compute the same shared secret via ECDH.
    const clientPublicKey = Uint8Array.from(Buffer.from(hello.publicKeyB64, 'base64'))
    if (clientPublicKey.length !== 32) {
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
    let auth: E2EEAuth
    try {
      auth = JSON.parse(plaintext) as E2EEAuth
    } catch {
      this.sendEncryptedControl({ type: 'e2ee_error', error: { code: 'bad_auth' } })
      this.onError(4001, 'Invalid e2ee_auth')
      return
    }

    if (auth.type !== 'e2ee_auth' || !auth.deviceToken) {
      this.sendEncryptedControl({ type: 'e2ee_error', error: { code: 'bad_auth' } })
      this.onError(4001, 'Invalid e2ee_auth')
      return
    }
    if (!this.validateToken(auth.deviceToken)) {
      this.sendEncryptedControl({ type: 'e2ee_error', error: { code: 'unauthorized' } })
      this.onError(4001, 'Unauthorized')
      return
    }

    this.deviceToken = auth.deviceToken
    this.state = 'ready'

    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }

    this.sendEncryptedControl({ type: 'e2ee_authenticated' })
    this.onReady(this)
  }

  private sendEncryptedControl(message: unknown): void {
    if (this.ws.readyState === this.ws.OPEN && this.sharedKey) {
      this.ws.send(encrypt(JSON.stringify(message), this.sharedKey))
    }
  }

  destroy(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
    this.sharedKey = null
    this.messageHandler = null
  }
}
