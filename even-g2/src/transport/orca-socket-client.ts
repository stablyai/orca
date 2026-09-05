// Browser reimplementation of mobile's DirectRpcClient (mobile/src/transport/direct-rpc-client.ts
// + rpc-client-socket-session.ts + rpc-client-stream-registry.ts), deliberately smaller: no
// relay, no liveness watchdog, one host at a time. Wire handshake and framing are unchanged —
// see spec S6. Keep the e2ee_hello -> e2ee_ready -> e2ee_auth -> e2ee_authenticated sequence and
// the encrypted-JSON / raw-binary framing in sync with the mobile reference if either changes.
import {
  deriveSharedKey,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from './glasses-e2ee'
import type { ConnectionState, RpcPort, RpcResponse } from './orca-rpc-wire'
import { parseHandshakeMessage, runAuthenticatedBootstrap } from './orca-socket-handshake'
import { PendingRequestRegistry } from './orca-request-registry'
import {
  SubscriptionRegistry,
  routeRpcResponse,
  type Subscription
} from './orca-subscription-registry'
import { ReconnectScheduler } from './orca-reconnect-scheduler'
import { ConnectionStageTimer } from './orca-connection-stage-timer'
import {
  decodeAuthenticatedBinaryFrame,
  decodeAuthenticatedRpcResponse,
  defaultSocketFactory,
  sendEncrypted,
  toUint8Array,
  type WebSocketLike
} from './orca-socket-frames'

export type { WebSocketLike } from './orca-socket-frames'

const DEFAULT_REQUEST_TIMEOUT_MS = 15000
const DEFAULT_CONNECT_TIMEOUT_MS = 10000
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10000

export type OrcaSocketClientOptions = {
  endpoint: string
  deviceToken: string
  serverPublicKeyB64: string
  socketFactory?: (url: string) => WebSocketLike
  onState?: (state: ConnectionState) => void
  onLog?: (line: string) => void
  // How long to wait for the socket to open before giving up and reconnecting. Default ~10s.
  connectTimeoutMs?: number
  // How long to wait after open for e2ee_ready/e2ee_authenticated before giving up. Default ~10s.
  handshakeTimeoutMs?: number
}

type Session = {
  socket: WebSocketLike
  sharedKey: Uint8Array | null
  authenticated: boolean
  stageTimer: ConnectionStageTimer
}

export class OrcaSocketClient implements RpcPort {
  private readonly serverPublicKey: Uint8Array
  private readonly pending = new PendingRequestRegistry()
  private readonly subscriptions = new SubscriptionRegistry()
  private readonly reconnect = new ReconnectScheduler()
  private session: Session | null = null
  private state: ConnectionState = 'connecting'
  private closed = false
  private authFailed = false
  private requestCounter = 0

  constructor(private readonly options: OrcaSocketClientOptions) {
    this.serverPublicKey = publicKeyFromBase64(options.serverPublicKeyB64)
    this.connect()
  }

  sendRequest(
    method: string,
    params?: unknown,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<RpcResponse> {
    if (this.authFailed) {
      return Promise.reject(new Error('Authentication failed — pairing may be revoked'))
    }
    const id = this.nextId()
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Request timed out after ${timeoutMs}ms: ${method}`))
      }, timeoutMs)
      this.pending.add({ id, method, params, resolve, reject, timer })
      this.sendIfAuthenticated(id, method, params)
    })
  }

  subscribe(
    method: string,
    params: unknown,
    onData: (result: unknown) => void,
    onBinary?: (payload: Uint8Array) => void
  ): () => void {
    const id = this.nextId()
    const subscription: Subscription = { id, method, params, onData, onBinary, cancelled: false }
    this.subscriptions.add(subscription)
    this.sendIfAuthenticated(id, method, params)
    return () => this.unsubscribe(id)
  }

  getState(): ConnectionState {
    return this.state
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.reconnect.cancel()
    const session = this.session
    this.session = null
    session?.stageTimer.clear()
    this.pending.rejectAll('Client closed')
    this.setState('disconnected')
    session?.socket.close()
  }

  private unsubscribe(id: string): void {
    const subscription = this.subscriptions.cancel(id)
    if (!subscription) {
      return
    }
    // Mirrors mobile's buildTerminalUnsubscribeParams: echo the original `terminal` id back as
    // `subscriptionId`, since terminal.subscribe acks a numeric streamId, not a subscription id.
    if (subscription.method === 'terminal.subscribe' && this.session?.authenticated) {
      const terminal = (subscription.params as { terminal?: unknown } | null)?.terminal
      if (typeof terminal === 'string') {
        this.sendIfAuthenticated(this.nextId(), 'terminal.unsubscribe', {
          subscriptionId: terminal
        })
      }
    }
  }

  private sendIfAuthenticated(id: string, method: string, params: unknown): void {
    if (this.session?.authenticated) {
      sendEncrypted(this.session.socket, this.session.sharedKey, {
        id,
        deviceToken: this.options.deviceToken,
        method,
        params
      })
    }
  }

  private connect(): void {
    if (this.closed || this.authFailed) {
      return
    }
    this.setState(this.reconnect.attemptCount > 0 ? 'reconnecting' : 'connecting')
    const factory = this.options.socketFactory ?? defaultSocketFactory
    const socket = factory(this.options.endpoint)
    socket.binaryType = 'arraybuffer'
    const session: Session = {
      socket,
      sharedKey: null,
      authenticated: false,
      stageTimer: new ConnectionStageTimer()
    }
    this.session = session
    const connectTimeoutMs = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    session.stageTimer.arm(connectTimeoutMs, () =>
      this.forceReconnect(session, 'connect timed out')
    )

    socket.onopen = () => {
      if (this.session !== session) {
        return
      }
      this.setState('handshaking')
      const handshakeTimeoutMs = this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
      session.stageTimer.arm(handshakeTimeoutMs, () =>
        this.forceReconnect(session, 'handshake timed out')
      )
      this.log(`ws open — sending e2ee_hello (${this.options.endpoint})`)
      const ephemeral = generateKeyPair()
      session.sharedKey = deriveSharedKey(ephemeral.secretKey, this.serverPublicKey)
      const hello = { type: 'e2ee_hello', publicKeyB64: publicKeyToBase64(ephemeral.publicKey) }
      try {
        socket.send(JSON.stringify(hello))
      } catch {
        this.handleSocketClosed(session)
      }
    }
    socket.onmessage = (event) => {
      if (this.session !== session) {
        return
      }
      this.handleMessage(session, event.data)
    }
    socket.onclose = () => this.handleSocketClosed(session)
    socket.onerror = () => this.log('socket error')
  }

  private handleMessage(session: Session, data: unknown): void {
    if (typeof data === 'string') {
      this.handleTextMessage(session, data)
      return
    }
    const bytes = toUint8Array(data)
    if (bytes) {
      this.handleBinaryMessage(session, bytes)
    }
  }

  private handleTextMessage(session: Session, raw: string): void {
    if (!session.authenticated) {
      this.handleHandshakeMessage(session, raw)
      return
    }
    if (!session.sharedKey) {
      return
    }
    const response = decodeAuthenticatedRpcResponse(raw, session.sharedKey)
    if (response) {
      routeRpcResponse(response, this.subscriptions, this.pending)
      return
    }
    // A decrypt/parse failure on an authenticated frame is a protocol error (tampered,
    // corrupted, or a wire mismatch), not a crash — close and let reconnect backoff take over.
    this.forceReconnect(session, 'decrypt/parse failed on encrypted RPC message — closing')
  }

  private handleHandshakeMessage(session: Session, raw: string): void {
    const event = parseHandshakeMessage(raw, session.sharedKey)
    switch (event.kind) {
      case 'ready':
        this.log('received e2ee_ready — sending e2ee_auth')
        sendEncrypted(session.socket, session.sharedKey, {
          type: 'e2ee_auth',
          deviceToken: this.options.deviceToken
        })
        return
      case 'authenticated':
        session.authenticated = true
        this.handleAuthenticated(session)
        return
      case 'rejected':
        this.handleAuthRejected(session)
        break
      case 'none':
        break
    }
  }

  private handleBinaryMessage(session: Session, bytes: Uint8Array): void {
    if (!session.authenticated || !session.sharedKey) {
      return
    }
    const decoded = decodeAuthenticatedBinaryFrame(bytes, session.sharedKey)
    if (!decoded) {
      this.forceReconnect(session, 'decrypt/parse failed on binary terminal frame — closing')
      return
    }
    const subscription = this.subscriptions.bySubscriptionForStream(decoded.streamId)
    subscription?.onBinary?.(decoded.plaintext)
  }

  private handleAuthenticated(session: Session): void {
    if (this.session !== session) {
      return
    }
    session.stageTimer.clear()
    this.reconnect.reset()
    this.log('authenticated')
    // Replay pending requests/subscriptions BEFORE publishing 'connected': a listener reacting
    // to 'connected' may itself create a request, and if that happened before replay it would
    // land in `pending` and get sent twice — once immediately, once by the replay loop below.
    runAuthenticatedBootstrap(
      this.options.deviceToken,
      () => this.nextId(),
      this.pending,
      this.subscriptions,
      (payload) => sendEncrypted(session.socket, session.sharedKey, payload)
    )
    this.setState('connected')
  }

  private handleSocketClosed(session: Session): void {
    if (this.session !== session) {
      return
    }
    session.stageTimer.clear()
    this.session = null
    this.pending.rejectAll('Disconnected')
    if (this.closed) {
      this.setState('disconnected')
      return
    }
    if (this.authFailed) {
      this.setState('auth-failed')
      return
    }
    this.setState('reconnecting')
    this.reconnect.schedule(() => this.connect())
  }

  private handleAuthRejected(session: Session): void {
    if (this.session !== session) {
      return
    }
    session.stageTimer.clear()
    this.authFailed = true
    this.session = null
    this.reconnect.cancel()
    this.pending.rejectAll('Authentication failed — pairing may be revoked')
    this.setState('auth-failed')
    this.log('e2ee auth failed — latched, no retry')
    session.socket.close()
  }

  // Shared by the stage-timeout and decode-failure paths: log, tear down the session, and let
  // handleSocketClosed's normal disconnected/auth-failed/reconnecting branching take over.
  private forceReconnect(session: Session, reason: string): void {
    if (this.session !== session) {
      return
    }
    this.log(reason)
    this.handleSocketClosed(session)
    session.socket.close()
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) {
      return
    }
    this.state = state
    this.options.onState?.(state)
  }

  private log(line: string): void {
    this.options.onLog?.(line)
  }

  private nextId(): string {
    this.requestCounter += 1
    return `g2-${this.requestCounter}-${Date.now()}`
  }
}
