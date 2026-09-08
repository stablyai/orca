import {
  decrypt,
  decryptBytes,
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyToBase64
} from './e2ee'
import { sendMobileTerminalBinaryFrame } from './mobile-terminal-binary-sender'
import { isRpcResponse } from './rpc-response-shape'
import { RpcClientSocketTimeouts } from './rpc-client-socket-timeouts'
import { isStaleRpcSocketEvent, logRpcSocketClose } from './rpc-socket-close-evidence'
import { describeSocketEvent, redactedWebSocketEndpoint } from './socket-event-debug'
import type { TerminalStreamFrame } from './terminal-stream-protocol'
import type { ConnectionLogEmitter, ConnectionState, RpcResponse } from './types'
import { websocketPayloadToUint8 } from './websocket-payload-bytes'

type SocketSessionOptions = {
  endpoint: string
  deviceToken: string
  serverPublicKey: Uint8Array
  getCurrentSocket: () => WebSocket | null
  getState: () => ConnectionState
  getReconnectAttempt: () => number
  isIntentionallyClosed: () => boolean
  emitLog: ConnectionLogEmitter
  onHandshakeStarted: () => void
  onAuthenticated: (session: RpcClientSocketSession) => void
  onAuthRejected: (reason: string) => void
  onRpcResponse: (response: RpcResponse) => void
  onBinary: (bytes: Uint8Array) => void
  onAnyInbound: (receivedAt: number) => void
  onAuthenticatedInbound: (session: RpcClientSocketSession) => void
  onClosed: (session: RpcClientSocketSession, closeCode?: number) => void
  onForcedClose: (session: RpcClientSocketSession) => void
}

export class RpcClientSocketSession {
  readonly socket: WebSocket
  readonly constructedAt = Date.now()
  private sharedKey: Uint8Array | null = null
  private authenticated = false
  private lastInboundAt: number | null = null
  private readonly timeouts: RpcClientSocketTimeouts

  constructor(private readonly options: SocketSessionOptions) {
    this.socket = new WebSocket(options.endpoint)
    this.timeouts = new RpcClientSocketTimeouts({
      emitLog: options.emitLog,
      getReconnectAttempt: options.getReconnectAttempt,
      expire: () => this.options.onForcedClose(this)
    })
    this.attachHandlers()
    this.timeouts.armConnect(
      () => this.options.getCurrentSocket() === this.socket,
      () => this.socket.readyState
    )
  }

  // Why: the hosted bridge multiplexes terminal bytes over one binary channel.
  sendTerminalBinaryFrame(frame: TerminalStreamFrame): boolean {
    return sendMobileTerminalBinaryFrame({
      frame,
      socket: this.socket,
      sharedKey: this.sharedKey,
      isConnected: this.options.getState() === 'connected',
      onSocketClosed: () => this.options.onForcedClose(this)
    })
  }

  sendEncrypted(request: unknown): boolean {
    if (this.socket.readyState === WebSocket.OPEN && this.sharedKey) {
      try {
        this.socket.send(encrypt(JSON.stringify(request), this.sharedKey))
        return true
      } catch {
        if (this.options.getCurrentSocket() === this.socket) {
          this.options.onForcedClose(this)
        }
        return false
      }
    }
    console.log('[net] sendEncrypted FAILED — channel not ready', {
      hasWs: this.options.getCurrentSocket() !== null,
      readyState: this.socket.readyState,
      hasKey: this.sharedKey !== null,
      state: this.options.getState()
    })
    if (
      this.options.getState() === 'connected' &&
      this.options.getCurrentSocket() === this.socket &&
      this.socket.readyState !== WebSocket.OPEN
    ) {
      console.log('[net] sendEncrypted detected ws desync — forcing reconnect', {
        readyState: this.socket.readyState
      })
      this.options.onForcedClose(this)
    }
    return false
  }

  close(): void {
    this.socket.close()
  }

  clearTimers(): void {
    this.timeouts.clearAll()
  }

  clearKey(): void {
    this.sharedKey = null
  }

  private attachHandlers(): void {
    this.socket.onopen = () => {
      if (this.isStale('open')) {
        return
      }
      console.log('[net] ws.onopen', { attempt: this.options.getReconnectAttempt() })
      this.timeouts.clearConnect()
      this.options.onHandshakeStarted()
      this.options.emitLog('success', 'WebSocket open', 'Starting E2EE handshake')
      const ephemeral = generateKeyPair()
      const hello = JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: publicKeyToBase64(ephemeral.publicKey)
      })
      try {
        this.socket.send(hello)
      } catch {
        this.options.onForcedClose(this)
        return
      }
      this.options.emitLog('info', 'Sent e2ee_hello', 'Awaiting server e2ee_ready')
      this.sharedKey = deriveSharedKey(ephemeral.secretKey, this.options.serverPublicKey)
      this.timeouts.armHandshake(
        () => this.options.getCurrentSocket() === this.socket && !this.authenticated
      )
    }
    this.socket.onmessage = (event) => {
      if (!this.isStale('message')) {
        void this.handleMessage(event.data)
      }
    }
    this.socket.onclose = (event) => {
      const closeCode = logRpcSocketClose({
        event,
        state: this.options.getState(),
        attempt: this.options.getReconnectAttempt(),
        intentionallyClosed: this.options.isIntentionallyClosed(),
        endpoint: redactedWebSocketEndpoint(this.options.endpoint),
        constructedAt: this.constructedAt,
        authenticated: this.authenticated,
        lastInboundAt: this.lastInboundAt
      })
      this.options.onClosed(this, closeCode)
    }
    this.socket.onerror = (event) => {
      if (this.isStale('error')) {
        return
      }
      console.log('[net] ws.onerror', {
        state: this.options.getState(),
        attempt: this.options.getReconnectAttempt(),
        eventFields: describeSocketEvent(event).fields
      })
    }
  }

  private async handleMessage(rawData: unknown): Promise<void> {
    const receivedAt = Date.now()
    this.lastInboundAt = receivedAt
    this.options.onAnyInbound(receivedAt)
    const raw = typeof rawData === 'string' ? rawData : null
    if (!this.authenticated) {
      this.handleHandshakeMessage(raw)
      return
    }
    if (!this.sharedKey || this.sharedKey.length !== 32) {
      return
    }
    if (raw === null) {
      const bytes = await websocketPayloadToUint8(rawData)
      if (this.options.getCurrentSocket() !== this.socket || !bytes) {
        return
      }
      const plaintext = decryptBytes(bytes, this.sharedKey)
      if (!plaintext) {
        return
      }
      this.options.onAuthenticatedInbound(this)
      this.options.onBinary(plaintext)
      return
    }
    const plaintext = decrypt(raw, this.sharedKey)
    if (plaintext === null) {
      return
    }
    this.options.onAuthenticatedInbound(this)
    let response: unknown
    try {
      response = JSON.parse(plaintext)
    } catch {
      return
    }
    if (isRpcResponse(response)) {
      this.options.onRpcResponse(response)
    }
  }

  private handleHandshakeMessage(raw: string | null): void {
    if (raw === null) {
      return
    }
    try {
      const message = JSON.parse(raw) as { type?: unknown }
      if (message.type === 'e2ee_ready') {
        this.options.emitLog('success', 'Received e2ee_ready', 'Sending device token')
        this.sendEncrypted({ type: 'e2ee_auth', deviceToken: this.options.deviceToken })
        return
      }
    } catch {
      // The authenticated handshake messages are encrypted.
    }
    if (!this.sharedKey || this.sharedKey.length !== 32) {
      return
    }
    const plaintext = decrypt(raw, this.sharedKey)
    if (plaintext === null) {
      return
    }
    try {
      const message = JSON.parse(plaintext) as {
        type?: unknown
        ok?: unknown
        error?: { code?: unknown }
      }
      if (message.type === 'e2ee_authenticated') {
        this.timeouts.clearHandshake()
        this.authenticated = true
        this.options.onAuthenticated(this)
      } else if (
        message.type === 'e2ee_error' ||
        (message.ok === false && message.error?.code === 'unauthorized')
      ) {
        // Why: the failure signal is loggable; the server error body is not.
        console.log('[net] e2ee auth FAILED', {
          signal: message.type === 'e2ee_error' ? 'e2ee_error' : 'unauthorized_response'
        })
        this.timeouts.clearHandshake()
        this.options.onAuthRejected('Unauthorized — pairing may be revoked')
      }
    } catch {
      // Ignore malformed handshake payloads.
    }
  }

  private isStale(eventName: string): boolean {
    return isStaleRpcSocketEvent(
      this.options.getCurrentSocket(),
      this.socket,
      eventName,
      this.options.getState(),
      this.options.getReconnectAttempt()
    )
  }
}
