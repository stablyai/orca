import WebSocket from 'ws'
import type nacl from 'tweetnacl'
import type { RuntimeCapability } from '../../shared/protocol-version'
import {
  decrypt,
  decryptBytes,
  deriveSharedKey,
  encrypt,
  encryptBytes,
  publicKeyFromBase64
} from '../../shared/e2ee-crypto'
import { parseRemoteRuntimeJsonText } from '../../shared/remote-runtime-request-frames'
import { parseRuntimeClientCapabilities } from '../runtime/rpc/runtime-client-capabilities'
import type {
  RuntimeRelayBridgeUpstream,
  RuntimeRelayBridgeUpstreamEvents,
  RuntimeRelayBridgeUpstreamOpen
} from './runtime-environment-relay-upstream'

type BridgeSessionState = 'awaiting_hello' | 'awaiting_auth' | 'authenticating' | 'ready' | 'closed'

export type RuntimeRelayBridgeSessionHooks = {
  /** Opens the Relay leg after the direct endpoint answered but did not prove the paired key. */
  fallBackToRelay(events: RuntimeRelayBridgeUpstreamEvents): Promise<RuntimeRelayBridgeUpstreamOpen>
  onAuthenticated(route: RuntimeRelayBridgeUpstream['route']): void
}

/**
 * Answers the client stack's legacy handshake in-process, then relays plaintext to the host leg.
 * Why in-process: the stack keeps one E2EE implementation; the host leg (direct or Relay)
 * carries its own end-to-end session with the paired server key.
 */
export class RuntimeRelayBridgeSession {
  private ws: WebSocket | null = null
  private upstream: RuntimeRelayBridgeUpstream | null = null
  private sharedKey: Uint8Array | null = null
  private state: BridgeSessionState = 'awaiting_hello'
  private pendingClose: { code: number; reason: string } | null = null

  readonly upstreamEvents: RuntimeRelayBridgeUpstreamEvents = {
    // Why drop before ready: the client has sent no request yet, so only keepalives can arrive.
    onText: (plaintext) => {
      if (this.state === 'ready' && this.sharedKey) {
        this.sendToClient(encrypt(plaintext, this.sharedKey))
      }
    },
    onBinary: (bytes) => {
      if (this.state === 'ready' && this.sharedKey) {
        this.sendToClient(Buffer.from(encryptBytes(bytes, this.sharedKey)))
      }
    },
    onPong: () => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.pong()
      }
    },
    onClose: (code, reason) => this.closeClient(code, reason)
  }

  constructor(
    private readonly bridgeKeys: nacl.BoxKeyPair,
    private readonly deviceToken: string,
    private readonly hooks: RuntimeRelayBridgeSessionHooks
  ) {}

  attach(ws: WebSocket, opened: RuntimeRelayBridgeUpstreamOpen): void {
    this.ws = ws
    this.upstream = opened.ok ? opened.upstream : null
    ws.on('message', (data, isBinary) => this.handleClientFrame(data, isBinary))
    // Why: client liveness pings must measure the host leg, not this in-process hop.
    ws.on('ping', () => this.upstream?.ping())
    ws.on('error', () => {})
    ws.on('close', () => {
      this.state = 'closed'
      this.upstream?.close()
    })
    if (this.pendingClose) {
      this.closeClient(this.pendingClose.code, this.pendingClose.reason)
    }
  }

  private handleClientFrame(data: WebSocket.RawData, isBinary: boolean): void {
    if (this.state === 'awaiting_hello') {
      this.acceptHello(isBinary ? null : data.toString())
    } else if (this.state === 'awaiting_auth') {
      this.acceptAuth(isBinary || !this.sharedKey ? null : decrypt(data.toString(), this.sharedKey))
    } else if (this.state === 'ready' && this.sharedKey && this.upstream) {
      if (isBinary) {
        const bytes = decryptBytes(
          new Uint8Array(Array.isArray(data) ? Buffer.concat(data) : data),
          this.sharedKey
        )
        if (bytes) {
          this.upstream.sendBinary(bytes)
        }
        return
      }
      const plaintext = decrypt(data.toString(), this.sharedKey)
      if (plaintext !== null) {
        this.upstream.sendText(plaintext)
      }
    }
  }

  private acceptHello(raw: string | null): void {
    let clientPublicKey: Uint8Array
    try {
      const hello: unknown = raw === null ? null : parseRemoteRuntimeJsonText(raw)
      if (
        typeof hello !== 'object' ||
        hello === null ||
        !('type' in hello) ||
        hello.type !== 'e2ee_hello' ||
        !('publicKeyB64' in hello) ||
        typeof hello.publicKeyB64 !== 'string'
      ) {
        throw new Error('invalid hello')
      }
      clientPublicKey = publicKeyFromBase64(hello.publicKeyB64)
    } catch {
      this.closeClient(4001, 'Invalid e2ee_hello')
      return
    }
    this.sharedKey = deriveSharedKey(this.bridgeKeys.secretKey, clientPublicKey)
    this.state = 'awaiting_auth'
    this.sendToClient(JSON.stringify({ type: 'e2ee_ready' }))
  }

  private acceptAuth(plaintext: string | null): void {
    let auth: unknown = null
    try {
      auth = plaintext === null ? null : parseRemoteRuntimeJsonText(plaintext)
    } catch {
      auth = null
    }
    if (
      typeof auth !== 'object' ||
      auth === null ||
      !('type' in auth) ||
      auth.type !== 'e2ee_auth' ||
      !('deviceToken' in auth) ||
      auth.deviceToken !== this.deviceToken ||
      !this.upstream
    ) {
      this.rejectClient()
      return
    }
    this.state = 'authenticating'
    const clientCapabilities = parseRuntimeClientCapabilities(
      'clientCapabilities' in auth ? auth.clientCapabilities : undefined
    )
    void this.authenticateUpstream(this.upstream, clientCapabilities)
  }

  private async authenticateUpstream(
    upstream: RuntimeRelayBridgeUpstream,
    clientCapabilities: readonly RuntimeCapability[]
  ): Promise<void> {
    let outcome = await upstream.authenticate(clientCapabilities)
    // Why: only the paired host can answer 'unauthorized' under our key; any other direct
    // failure means the address now reaches someone else, so Relay may still reach the server.
    if (outcome === 'failed' && upstream.route === 'direct' && this.state === 'authenticating') {
      upstream.close()
      this.upstream = null
      const relay = await this.hooks.fallBackToRelay(this.upstreamEvents)
      if (this.state !== 'authenticating') {
        if (relay.ok) {
          relay.upstream.close()
        }
        return
      }
      if (!relay.ok) {
        if (relay.unauthorized) {
          this.rejectClient()
        } else {
          this.closeClient(1011, relay.message)
        }
        return
      }
      this.upstream = relay.upstream
      outcome = await relay.upstream.authenticate(clientCapabilities)
    }
    if (this.state !== 'authenticating' || !this.upstream) {
      return
    }
    if (outcome === 'unauthorized') {
      this.rejectClient()
    } else if (outcome === 'failed') {
      this.closeClient(1011, 'The Orca server did not accept the session')
    } else {
      this.state = 'ready'
      this.hooks.onAuthenticated(this.upstream.route)
      this.sendEncryptedControl({ type: 'e2ee_authenticated' })
    }
  }

  // Why the same frame the host sends: the client marks the access revoked only on this shape.
  private rejectClient(): void {
    this.sendEncryptedControl({ type: 'e2ee_error', error: { code: 'unauthorized' } })
    this.closeClient(4001, 'Unauthorized')
  }

  private sendEncryptedControl(message: unknown): void {
    if (this.sharedKey) {
      this.sendToClient(encrypt(JSON.stringify(message), this.sharedKey))
    }
  }

  private sendToClient(frame: string | Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(frame, { binary: typeof frame !== 'string' })
    }
  }

  private closeClient(code: number, reason: string): void {
    if (!this.ws) {
      this.pendingClose ??= { code, reason }
      return
    }
    this.state = 'closed'
    this.upstream?.close()
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(code, reason.slice(0, 120))
    }
  }
}
