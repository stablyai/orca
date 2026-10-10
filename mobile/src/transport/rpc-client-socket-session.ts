import {
  decrypt,
  decryptBytes,
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyToBase64
} from './e2ee'
import { isRpcResponse } from './rpc-response-shape'
import { isStaleRpcSocketEvent, logRpcSocketClose } from './rpc-socket-close-evidence'
import { describeSocketEvent, redactSocketEndpoint } from './socket-event-debug'
import {
  releaseSocketTimer,
  rememberSocketDeadlineClock,
  startSocketDeadlineClock,
  takeSocketDeadline
} from './socket-deadline-clock'
import { reportSocketDeadline, type SocketDeadlineKind } from './socket-deadline-suspension'
import type { ConnectionLogEmitter, ConnectionState, RpcResponse } from './types'
import { websocketPayloadToUint8 } from './websocket-payload-bytes'

const CONNECT_TIMEOUT_MS = 12_000
const HANDSHAKE_TIMEOUT_MS = 5_000
const WEBSOCKET_CONNECTING_STATE = 0

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
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: SocketSessionOptions) {
    this.socket = new WebSocket(options.endpoint)
    this.attachHandlers()
    this.armConnectTimeout()
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
    this.connectTimer = releaseSocketTimer(this.connectTimer)
    this.handshakeTimer = releaseSocketTimer(this.handshakeTimer)
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
      this.clearConnectTimer()
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
      this.armHandshakeTimeout()
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
        endpoint: redactSocketEndpoint(this.options.endpoint),
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
      const error = event as { message?: string } | undefined
      const description = describeSocketEvent(event)
      console.log('[net] ws.onerror', {
        message: error?.message,
        state: this.options.getState(),
        attempt: this.options.getReconnectAttempt(),
        eventKeys: description.keys,
        eventStr: description.json
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
        this.clearHandshakeTimer()
        this.authenticated = true
        this.options.onAuthenticated(this)
      } else if (
        message.type === 'e2ee_error' ||
        (message.ok === false && message.error?.code === 'unauthorized')
      ) {
        console.log('[net] e2ee auth FAILED', {
          msgType: message.type,
          error: message.error
        })
        this.clearHandshakeTimer()
        this.options.onAuthRejected('Unauthorized — pairing may be revoked')
      }
    } catch {
      // Ignore malformed handshake payloads.
    }
  }

  private armConnectTimeout(): void {
    this.armSocketDeadline('connect', CONNECT_TIMEOUT_MS)
  }

  private armHandshakeTimeout(): void {
    this.armSocketDeadline('handshake', HANDSHAKE_TIMEOUT_MS)
  }

  private armSocketDeadline(kind: SocketDeadlineKind, timeoutMs: number): void {
    const timer = setTimeout(() => {
      const sample = takeSocketDeadline(timer)
      if (kind === 'connect') {
        this.connectTimer = null
      } else {
        this.handshakeTimer = null
      }
      const current = this.options.getCurrentSocket() === this.socket
      const pending =
        kind === 'connect'
          ? current && this.socket.readyState === WEBSOCKET_CONNECTING_STATE
          : current && !this.authenticated
      if (!pending) {
        return
      }
      reportSocketDeadline(
        {
          kind,
          ...sample,
          timeoutMs,
          ...(kind === 'connect' ? { attempt: this.options.getReconnectAttempt() } : {})
        },
        this.options.emitLog,
        () => this.options.onForcedClose(this)
      )
    }, timeoutMs)
    rememberSocketDeadlineClock(timer, startSocketDeadlineClock())
    if (kind === 'connect') {
      this.connectTimer = timer
    } else {
      this.handshakeTimer = timer
    }
  }

  private clearConnectTimer(): void {
    this.connectTimer = releaseSocketTimer(this.connectTimer)
  }

  private clearHandshakeTimer(): void {
    this.handshakeTimer = releaseSocketTimer(this.handshakeTimer)
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
