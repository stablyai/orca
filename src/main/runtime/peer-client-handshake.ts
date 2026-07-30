import WebSocket from 'ws'
import {
  generateKeyPair,
  deriveSharedKey,
  publicKeyFromBase64,
  publicKeyToBase64,
  encrypt,
  decrypt
} from '../../shared/e2ee-crypto'
import type { PairingOffer } from '../../shared/pairing'

const HANDSHAKE_TIMEOUT_MS = 5_000
// Why: must match E2EEChannel's onError(4001, ...) close code for unauthorized/bad handshake.
export const UNAUTHORIZED_CLOSE_CODE = 4001

export type HandshakeState = 'awaiting_ready' | 'awaiting_auth' | 'ready'

export type PeerClientHandshakeDeps = {
  createSocket: (endpoint: string) => WebSocket
  getDisplayName: () => string | null
  // Why: fires once e2ee_authenticated arrives, before any RPC dispatch.
  onAuthenticated: () => void
  // Why: post-handshake decrypted JSON envelopes (RPC replies, stream messages).
  onMessage: (message: Record<string, unknown>) => void
  onBinaryMessage: (raw: Buffer) => void
  onClosed: (code: number) => void
}

// Why: owns the v1 e2ee_hello/e2ee_auth handshake and the resulting shared
// key — mirrors mobile/src/transport/rpc-client.ts's connect() handshake so a
// client Orca can dial into another Orca's runtime-rpc WebSocket server.
export class PeerClientHandshake {
  private ws: WebSocket | null = null
  private sharedKey: Uint8Array | null = null
  private state: HandshakeState = 'awaiting_ready'
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: PeerClientHandshakeDeps) {}

  getWs(): WebSocket | null {
    return this.ws
  }

  getSharedKey(): Uint8Array | null {
    return this.sharedKey
  }

  getState(): HandshakeState {
    return this.state
  }

  teardown(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.sharedKey = null
    this.state = 'awaiting_ready'
    if (this.ws) {
      // Why: strip listeners first so the socket we're replacing can't fire a
      // stale 'close'/'message' event against the connection that supersedes it.
      this.ws.removeAllListeners()
      this.ws.terminate()
      this.ws = null
    }
  }

  open(offer: PairingOffer): void {
    this.state = 'awaiting_ready'
    const socket = this.deps.createSocket(offer.endpoint)
    this.ws = socket

    socket.once('open', () => {
      if (this.ws !== socket) {
        return
      }
      const ephemeral = generateKeyPair()
      this.sharedKey = deriveSharedKey(ephemeral.secretKey, publicKeyFromBase64(offer.publicKeyB64))
      socket.send(
        JSON.stringify({ type: 'e2ee_hello', publicKeyB64: publicKeyToBase64(ephemeral.publicKey) })
      )
      this.timer = setTimeout(() => {
        if (this.ws === socket && this.state !== 'ready') {
          socket.terminate()
        }
      }, HANDSHAKE_TIMEOUT_MS)
    })

    socket.on('message', (raw, isBinary) => {
      if (this.ws !== socket) {
        return
      }
      if (isBinary) {
        this.deps.onBinaryMessage(raw as Buffer)
        return
      }
      this.handleText(raw.toString(), offer)
    })

    socket.once('error', () => {
      // Why: 'close' always follows 'error' on ws sockets and is where reconnect is scheduled.
    })

    socket.once('close', (code) => {
      if (this.ws !== socket) {
        return
      }
      this.ws = null
      this.sharedKey = null
      if (this.timer) {
        clearTimeout(this.timer)
        this.timer = null
      }
      this.deps.onClosed(code)
    })
  }

  sendEncrypted(payload: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.sharedKey) {
      return false
    }
    this.ws.send(encrypt(JSON.stringify(payload), this.sharedKey))
    return true
  }

  private handleText(text: string, offer: PairingOffer): void {
    if (this.state === 'awaiting_ready') {
      const hello = parseJson(text)
      if (hello?.type === 'e2ee_ready') {
        this.state = 'awaiting_auth'
        const displayName = this.deps.getDisplayName()
        this.sendEncrypted({
          type: 'e2ee_auth',
          deviceToken: offer.deviceToken,
          // Why: rides the handshake so the host's connected-client list can show who's connecting.
          ...(displayName ? { displayName } : {})
        })
      }
      return
    }

    if (!this.sharedKey) {
      return
    }
    const plaintext = decrypt(text, this.sharedKey)
    if (plaintext === null) {
      return
    }
    const message = parseJson(plaintext)
    if (!message) {
      return
    }

    if (this.state === 'awaiting_auth') {
      if (message.type === 'e2ee_authenticated') {
        this.state = 'ready'
        if (this.timer) {
          clearTimeout(this.timer)
          this.timer = null
        }
        this.deps.onAuthenticated()
      } else if (message.type === 'e2ee_error') {
        // Why: closing with the same code the server uses for onError(4001, ...)
        // routes this through onClosed's unauthorized branch, which latches to
        // 'closed' instead of retrying a rejected pairing.
        this.ws?.close(UNAUTHORIZED_CLOSE_CODE)
      }
      return
    }

    this.deps.onMessage(message)
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
