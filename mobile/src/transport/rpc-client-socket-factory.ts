import { ConnectionRouteDial } from './connection-route-dial'
import { ConnectionRouteError, type ConnectionRouteProvider } from './connection-route'
import { publicKeyFromBase64 } from './e2ee'
import { RpcClientSocketSession } from './rpc-client-socket-session'
import { redactSocketEndpoint } from './socket-event-debug'
import type { ConnectionLogEmitter, ConnectionState, RpcResponse } from './types'

type SocketFactoryOptions = {
  routeProvider?: ConnectionRouteProvider
  onCreated: (session: RpcClientSocketSession) => void
  onRouteFailure: (message: string, retryable: boolean) => void
  endpoint: string
  deviceToken: string
  serverPublicKeyB64: string
  getCurrentSocket: () => WebSocket | null
  getState: () => ConnectionState
  getReconnectAttempt: () => number
  getLastConnectedAt: () => number | null
  isIntentionallyClosed: () => boolean
  emitLog: ConnectionLogEmitter
  onHandshakeStarted: () => void
  onAuthenticated: (session: RpcClientSocketSession) => void
  onAuthRejected: (reason: string) => void
  onRpcResponse: (response: RpcResponse) => void
  onBinary: (bytes: Uint8Array) => void
  onAuthenticatedInbound: (session: RpcClientSocketSession) => void
  onClosed: (session: RpcClientSocketSession, closeCode?: number) => void
  onForcedClose: (session: RpcClientSocketSession) => void
}

export class RpcClientSocketFactory {
  private readonly routeDial: ConnectionRouteDial | null
  private readonly serverPublicKey: Uint8Array
  private lastInboundAt: number | null = null
  private lastSocketClosedAt: number | null = null
  private constructionCount = 0
  private dialStartedAt = 0

  constructor(private readonly options: SocketFactoryOptions) {
    this.routeDial = options.routeProvider ? new ConnectionRouteDial(options.routeProvider) : null
    this.serverPublicKey = publicKeyFromBase64(options.serverPublicKeyB64)
  }

  open(): void {
    if (!this.routeDial) {
      this.options.onCreated(this.openSocket(this.options.endpoint))
      return
    }
    this.options.emitLog('info', 'Opening connection tunnel')
    this.routeDial.open(
      this.options.endpoint,
      (lease) => {
        for (const stage of lease.stages ?? []) {
          this.options.emitLog('info', stage.message)
        }
        this.options.onCreated(this.openSocket(lease.endpoint))
      },
      (error) => {
        const message =
          error instanceof ConnectionRouteError ? error.message : 'Connection tunnel failed.'
        for (const stage of error instanceof ConnectionRouteError ? (error.stages ?? []) : []) {
          this.options.emitLog('info', stage.message)
        }
        this.options.emitLog('warn', message)
        this.options.onRouteFailure(
          message,
          !(error instanceof ConnectionRouteError) || error.retryable
        )
      }
    )
  }

  closeRoute(): void {
    this.routeDial?.close()
  }

  private openSocket(endpoint: string): RpcClientSocketSession {
    const now = Date.now()
    const lastConnectedAt = this.options.getLastConnectedAt()
    this.constructionCount++
    console.log('[net] openConnection', {
      attempt: this.options.getReconnectAttempt(),
      endpoint: redactSocketEndpoint(this.options.endpoint),
      wsCount: this.constructionCount,
      msSinceLastConnected: lastConnectedAt !== null ? now - lastConnectedAt : null,
      msSinceLastClose: this.lastSocketClosedAt !== null ? now - this.lastSocketClosedAt : null,
      msSinceLastInbound: this.lastInboundAt !== null ? now - this.lastInboundAt : null
    })
    this.dialStartedAt = now
    this.options.emitLog(
      'info',
      this.options.getReconnectAttempt() > 0
        ? `Reconnecting (attempt ${this.options.getReconnectAttempt() + 1})`
        : 'Opening WebSocket',
      redactSocketEndpoint(this.options.endpoint)
    )
    return new RpcClientSocketSession({
      endpoint,
      deviceToken: this.options.deviceToken,
      serverPublicKey: this.serverPublicKey,
      getCurrentSocket: this.options.getCurrentSocket,
      getState: this.options.getState,
      getReconnectAttempt: this.options.getReconnectAttempt,
      isIntentionallyClosed: this.options.isIntentionallyClosed,
      emitLog: this.options.emitLog,
      onHandshakeStarted: this.options.onHandshakeStarted,
      onAuthenticated: this.options.onAuthenticated,
      onAuthRejected: this.options.onAuthRejected,
      onRpcResponse: this.options.onRpcResponse,
      onBinary: this.options.onBinary,
      onAnyInbound: (receivedAt) => (this.lastInboundAt = receivedAt),
      onAuthenticatedInbound: this.options.onAuthenticatedInbound,
      onClosed: this.options.onClosed,
      onForcedClose: this.options.onForcedClose
    })
  }

  getDialStartedAt(): number {
    return this.dialStartedAt
  }

  noteClosed(): void {
    this.lastSocketClosedAt = Date.now()
  }
}
