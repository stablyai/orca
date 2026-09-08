import type { ConnectOptions, RpcClient, SendRequestOptions } from './rpc-client'
import { DirectConnectionLog } from './direct-connection-log'
import { RpcClientAuthenticationRetry } from './rpc-client-authentication-retry'
import { RpcClientConnectionState } from './rpc-client-connection-state'
import {
  RpcClientReconnectSchedule,
  RPC_RECONNECT_ATTEMPT_LIMIT
} from './rpc-client-reconnect-schedule'
import { RpcClientRequestTracker } from './rpc-client-request-tracker'
import { RpcClientSocketCloseController } from './rpc-client-socket-close-controller'
import { RpcClientSocketFactory } from './rpc-client-socket-factory'
import type { RpcClientSocketSession } from './rpc-client-socket-session'
import {
  RpcClientStreamRegistry,
  type RpcStreamingListener,
  type RpcStreamSubscribeOptions
} from './rpc-client-stream-registry'
import { nudgeRpcClientForeground } from './rpc-client-foreground-nudge'
import { isLivenessProbeResponseId, RpcClientLivenessSession } from './rpc-client-liveness-session'
import type { TerminalStreamFrame } from './terminal-stream-protocol'
import type { ConnectionState, ForegroundNudgeReason, RpcResponse } from './types'
import { negotiateMobileRuntimeCapabilities } from './mobile-runtime-capability-negotiation'

export class DirectRpcClient implements RpcClient {
  private socketSession: RpcClientSocketSession | null = null
  private readonly connectionState: RpcClientConnectionState
  private readonly reconnect: RpcClientReconnectSchedule
  private readonly requests: RpcClientRequestTracker
  private readonly streams: RpcClientStreamRegistry
  private readonly liveness: RpcClientLivenessSession
  private readonly socketFactory: RpcClientSocketFactory
  private readonly authenticationRetry: RpcClientAuthenticationRetry
  private readonly socketClose: RpcClientSocketCloseController
  private requestCounter = 0
  private readonly connectionLog: DirectConnectionLog
  private intentionallyClosed = false
  private authenticationGeneration = 0

  constructor(
    private readonly endpoint: string,
    private readonly deviceToken: string,
    serverPublicKeyB64: string,
    private readonly options: ConnectOptions
  ) {
    this.connectionLog = new DirectConnectionLog(endpoint, options.onLog)
    this.reconnect = new RpcClientReconnectSchedule({
      openConnection: () => this.openConnection(),
      rejectConnectWaiters: (reason) => this.connectionState.rejectWaiters(reason),
      emitLog: (message, detail) =>
        this.connectionLog.emit('info', message, detail, { code: 'retry-scheduled' })
    })
    this.connectionState = new RpcClientConnectionState({
      endpoint,
      initialListener: options.onStateChange,
      getReconnectAttempt: () => this.reconnect.getAttempt(),
      isClosed: () => this.intentionallyClosed
    })
    this.streams = new RpcClientStreamRegistry({
      nextId: () => this.nextId(),
      deviceToken,
      getState: () => this.connectionState.get(),
      sendEncrypted: (request) => this.sendEncrypted(request)
    })
    this.requests = new RpcClientRequestTracker({
      nextId: () => this.nextId(),
      deviceToken,
      getState: () => this.connectionState.get(),
      waitForConnected: (timeoutMs) => this.waitForConnected(timeoutMs),
      sendEncrypted: (request) => this.sendEncrypted(request)
    })
    this.liveness = new RpcClientLivenessSession({
      sendProbe: (probeId) => this.sendLivenessProbe(probeId),
      terminate: (session) => {
        if (this.socketSession === session) {
          this.socketClose.forceClose(session)
        }
      },
      onTimeout: this.connectionLog.livenessTimeout,
      nextId: () => this.nextId()
    })
    this.socketFactory = new RpcClientSocketFactory({
      endpoint,
      deviceToken,
      serverPublicKeyB64,
      getCurrentSocket: () => this.socketSession?.socket ?? null,
      getState: () => this.getState(),
      getReconnectAttempt: () => this.getReconnectAttempt(),
      getLastConnectedAt: () => this.getLastConnectedAt(),
      isIntentionallyClosed: () => this.intentionallyClosed,
      emitLog: this.connectionLog.emit,
      onHandshakeStarted: () => this.connectionState.publish('handshaking'),
      onAuthenticated: (session) => this.handleAuthenticated(session),
      onAuthRejected: (reason) => this.authenticationRetry.reject(reason),
      onRpcResponse: (response) => this.handleRpcResponse(response),
      onBinary: (bytes) => this.streams.handleBinary(bytes),
      onAuthenticatedInbound: (session) => this.liveness.noteInbound(session),
      onClosed: (session, closeCode) => this.socketClose.handle(session, closeCode),
      onForcedClose: (session) => this.socketClose.forceClose(session)
    })
    this.authenticationRetry = new RpcClientAuthenticationRetry({
      endpoint,
      stopLiveness: () => this.liveness.stop(),
      emitWarning: (message, detail) =>
        this.connectionLog.emit('warn', message, detail, { code: 'authentication-rejected' }),
      retry: (reason) => this.retryAuthentication(reason),
      latchFailure: (reason) => this.latchAuthenticationFailure(reason)
    })
    this.socketClose = new RpcClientSocketCloseController({
      connectionState: this.connectionState,
      reconnect: this.reconnect,
      requests: this.requests,
      streams: this.streams,
      socketFactory: this.socketFactory,
      authenticationRetry: this.authenticationRetry,
      getCurrentSession: () => this.socketSession,
      clearCurrentSession: () => (this.socketSession = null),
      getAuthenticationGeneration: () => this.authenticationGeneration,
      isIntentionallyClosed: () => this.intentionallyClosed,
      stopLiveness: (session) => this.liveness.stop(session),
      emitWarning: (message, detail, evidence) =>
        this.connectionLog.emit('warn', message, detail, evidence)
    })
    this.openConnection()
  }

  sendRequest(
    method: string,
    params?: unknown,
    options?: SendRequestOptions
  ): Promise<RpcResponse> {
    return this.requests.sendRequest(method, params, options)
  }

  subscribe(
    method: string,
    params: unknown,
    onData: RpcStreamingListener,
    options?: RpcStreamSubscribeOptions
  ): () => void {
    return this.streams.subscribe(method, params, onData, options)
  }

  updateTerminalSubscriptionViewport(
    terminal: string,
    viewport: { cols: number; rows: number }
  ): void {
    this.streams.updateTerminalViewport(terminal, viewport)
  }

  sendTerminalBinaryFrame(frame: TerminalStreamFrame): boolean {
    return this.socketSession?.sendTerminalBinaryFrame(frame) ?? false
  }

  getState(): ConnectionState {
    return this.connectionState.get()
  }

  getReconnectAttempt(): number {
    return this.reconnect.getAttempt()
  }

  getLastConnectedAt(): number | null {
    return this.connectionState.getLastConnectedAt()
  }

  getLastInboundAt = (): number | null => this.liveness.getLastInboundAt()

  onStateChange(listener: (state: ConnectionState) => void): () => void {
    return this.connectionState.addListener(listener)
  }

  notifyForeground(_reason?: ForegroundNudgeReason): void {
    if (this.intentionallyClosed) {
      return
    }
    nudgeRpcClientForeground({
      getState: () => this.getState(),
      getReconnectAttempt: () => this.getReconnectAttempt(),
      dialAgeMs: Date.now() - this.socketFactory.getDialStartedAt(),
      hasReconnectTimer: () => this.reconnect.hasTimer(),
      probeLiveness: () => this.liveness.probeNow(),
      abandonDial: () => {
        const dialing = this.socketSession
        if (!dialing) {
          return false
        }
        this.socketClose.forceClose(dialing)
        return true
      },
      redial: (keepTimer) => this.reconnect.redialNow(keepTimer)
    })
  }

  close(): void {
    this.intentionallyClosed = true
    this.reconnect.cancel()
    const session = this.socketSession
    session?.clearTimers()
    this.liveness.stop()
    session?.close()
    this.socketSession = null
    session?.clearKey()
    this.connectionState.publish('disconnected')
    this.requests.rejectAll('Client closed', { deliveryUnknown: true })
  }

  private openConnection(): void {
    if (this.intentionallyClosed) {
      return
    }
    this.connectionState.publish('connecting')
    this.socketSession = this.socketFactory.open()
  }

  private handleAuthenticated(session: RpcClientSocketSession): void {
    this.liveness.start(session)
    const generation = ++this.authenticationGeneration
    negotiateMobileRuntimeCapabilities({
      sendRequest: (method, params) =>
        this.requests.sendAuthenticatedRequest(method, params, 5_000),
      current: () => this.socketSession === session && this.authenticationGeneration === generation,
      onReady: () => {
        this.reconnect.authenticated()
        this.authenticationRetry.accepted()
        this.connectionState.publish('connected')
        this.connectionLog.connected()
        this.streams.replayAfterAuthentication()
      },
      onFailure: () => this.socketClose.forceClose(session)
    })
  }

  private handleRpcResponse(response: RpcResponse): void {
    if (isLivenessProbeResponseId(response.id)) {
      return
    }
    if (!response.ok && response.error.code === 'unauthorized') {
      this.authenticationRetry.reject('Unauthorized — pairing may be revoked')
      return
    }
    if (!this.streams.handleResponse(response)) {
      this.requests.resolve(response)
    }
  }

  private retryAuthentication(reason: string): void {
    const closing = this.socketSession
    this.socketSession = null
    closing?.clearKey()
    this.streams.markForReplay()
    this.requests.rejectAll(reason)
    closing?.close()
    this.connectionState.publish('reconnecting')
    this.reconnect.schedule()
  }

  private latchAuthenticationFailure(reason: string): void {
    this.intentionallyClosed = true
    this.socketSession?.close()
    this.socketSession = null
    this.connectionState.publish('auth-failed')
    this.requests.rejectAll(reason)
  }

  private sendEncrypted(request: unknown): boolean {
    if (this.socketSession) {
      return this.socketSession.sendEncrypted(request)
    }
    console.log('[net] sendEncrypted FAILED — channel not ready', {
      hasWs: false,
      hasKey: false,
      state: this.getState()
    })
    return false
  }

  private sendLivenessProbe(probeId: string): boolean {
    if (this.getState() !== 'connected') {
      return false
    }
    return this.sendEncrypted({
      id: probeId,
      deviceToken: this.deviceToken,
      method: 'status.get'
    })
  }

  private waitForConnected(timeoutMs?: number): Promise<void> {
    if (
      this.getState() === 'reconnecting' &&
      this.getReconnectAttempt() >= RPC_RECONNECT_ATTEMPT_LIMIT
    ) {
      return Promise.reject(new Error('Connection retry limit reached'))
    }
    return this.connectionState.waitForConnected(timeoutMs)
  }

  private nextId(): string {
    return `rpc-${++this.requestCounter}-${Date.now()}`
  }
}
