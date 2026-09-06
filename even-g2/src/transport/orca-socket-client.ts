// Browser reimplementation of mobile's DirectRpcClient (mobile/src/transport/direct-rpc-client.ts
// + rpc-client-socket-session.ts + rpc-client-stream-registry.ts), deliberately smaller: no
// relay, one host at a time. Wire handshake and framing are unchanged — see spec S6. Keep the
// e2ee_hello -> e2ee_ready -> e2ee_auth -> e2ee_authenticated sequence and the encrypted-JSON /
// raw-binary framing in sync with the mobile reference if either changes.
//
// Finding #18: a socket can go silent (peer stops responding, network drops packets) without
// ever firing onclose/onerror — TCP/WS give no timely signal for that. A post-auth liveness
// watchdog periodically probes with a lightweight status.get and force-reconnects (reusing the
// existing ReconnectScheduler backoff) if the probe doesn't answer within its own deadline.
import { publicKeyFromBase64 } from './glasses-e2ee'
import type { ConnectionState, RpcPort, RpcResponse } from './orca-rpc-wire'
import {
  parseHandshakeMessage,
  reactToHandshakeMessage,
  runAuthenticatedBootstrap,
  startHandshakeStage
} from './orca-socket-handshake'
import { PendingRequestRegistry } from './orca-request-registry'
import {
  SubscriptionRegistry,
  routeAuthenticatedTextFrame,
  terminalUnsubscribeParams,
  type Subscription
} from './orca-subscription-registry'
import { ReconnectScheduler } from './orca-reconnect-scheduler'
import { ConnectionStageTimer, RepeatingProbeTimer } from './orca-connection-stage-timer'
import {
  decodeAuthenticatedBinaryFrame,
  defaultSocketFactory,
  sendEncrypted,
  toUint8Array,
  type WebSocketLike
} from './orca-socket-frames'

export type { WebSocketLike } from './orca-socket-frames'

const DEFAULT_REQUEST_TIMEOUT_MS = 15000
const DEFAULT_CONNECT_TIMEOUT_MS = 10000
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10000
// Finding #18: liveness probe cadence + response deadline for an authenticated socket.
const DEFAULT_LIVENESS_INTERVAL_MS = 30000
const DEFAULT_LIVENESS_TIMEOUT_MS = 10000

export type OrcaSocketClientOptions = {
  endpoint: string
  deviceToken: string
  serverPublicKeyB64: string
  socketFactory?: (url: string) => WebSocketLike
  onState?: (state: ConnectionState) => void
  onLog?: (line: string) => void
  // Stage deadlines before reconnecting. Defaults: connect/handshake ~10s each.
  connectTimeoutMs?: number
  handshakeTimeoutMs?: number
  // Finding #18: post-auth liveness probe cadence + response deadline. Defaults 30s/10s.
  livenessIntervalMs?: number
  livenessTimeoutMs?: number
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
  private readonly livenessWatchdog = new RepeatingProbeTimer()

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
    this.livenessWatchdog.stop()
    const session = this.session
    this.session = null
    session?.stageTimer.clear()
    this.pending.rejectAll('Client closed')
    this.setState('disconnected')
    session?.socket.close()
  }

  private unsubscribe(id: string): void {
    const subscription = this.subscriptions.cancel(id)
    if (!subscription || !this.session?.authenticated) {
      return
    }
    const params = terminalUnsubscribeParams(subscription)
    if (params) {
      this.sendIfAuthenticated(this.nextId(), 'terminal.unsubscribe', params)
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
    const onConnectTimeout = (): void => this.forceReconnect(session, 'connect timed out')
    session.stageTimer.arm(connectTimeoutMs, onConnectTimeout)

    socket.onopen = () => {
      if (this.session !== session) {
        return
      }
      this.setState('handshaking')
      const handshakeTimeoutMs = this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
      this.log(`ws open — sending e2ee_hello (${this.options.endpoint})`)
      startHandshakeStage(session, this.serverPublicKey, handshakeTimeoutMs, {
        onTimeout: () => this.forceReconnect(session, 'handshake timed out'),
        onFailure: () => this.handleSocketClosed(session)
      })
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
    // A decrypt/parse failure on an authenticated frame is a protocol error (tampered,
    // corrupted, or a wire mismatch), not a crash — close and let reconnect backoff take over.
    routeAuthenticatedTextFrame(raw, session.sharedKey, this.subscriptions, this.pending, () =>
      this.forceReconnect(session, 'decrypt/parse failed on encrypted RPC message — closing')
    )
  }

  private handleHandshakeMessage(session: Session, raw: string): void {
    const event = parseHandshakeMessage(raw, session.sharedKey)
    reactToHandshakeMessage(event, session, this.options.deviceToken, {
      onReady: () => this.log('received e2ee_ready — sending e2ee_auth'),
      onAuthenticated: () => {
        session.authenticated = true
        this.handleAuthenticated(session)
      },
      onRejected: () => this.handleAuthRejected(session)
    })
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
    const livenessIntervalMs = this.options.livenessIntervalMs ?? DEFAULT_LIVENESS_INTERVAL_MS
    this.livenessWatchdog.start(livenessIntervalMs, () => this.probeLiveness(session))
  }

  private handleSocketClosed(session: Session): void {
    if (this.session !== session) {
      return
    }
    session.stageTimer.clear()
    this.livenessWatchdog.stop()
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
    this.livenessWatchdog.stop()
    this.authFailed = true
    this.session = null
    this.reconnect.cancel()
    this.pending.rejectAll('Authentication failed — pairing may be revoked')
    this.setState('auth-failed')
    this.log('e2ee auth failed — latched, no retry')
    session.socket.close()
  }

  // Finding #18: an authenticated socket that goes silent (peer stopped responding, packets
  // dropped) never fires onclose/onerror on its own — periodically prove it's still alive.
  private probeLiveness(session: Session): void {
    if (this.session !== session || !session.authenticated) {
      return // superseded by a reconnect/close since this tick was scheduled
    }
    const livenessTimeoutMs = this.options.livenessTimeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS
    this.sendRequest('status.get', undefined, livenessTimeoutMs).catch(() => {
      if (this.session === session) {
        this.forceReconnect(session, 'liveness probe timed out — socket is silently dead')
      }
    })
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
