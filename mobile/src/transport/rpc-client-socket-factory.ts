import { publicKeyFromBase64 } from './e2ee'
import { RpcClientSocketSession } from './rpc-client-socket-session'
import { redactSocketEndpoint } from './socket-event-debug'
import type { ConnectionLogLevel, ConnectionState, RpcResponse } from './types'

type SocketFactoryOptions = {
  endpoint: string
  deviceToken: string
  serverPublicKeyB64: string
  getCurrentSocket: () => WebSocket | null
  getState: () => ConnectionState
  getReconnectAttempt: () => number
  getLastConnectedAt: () => number | null
  isIntentionallyClosed: () => boolean
  emitLog: (level: ConnectionLogLevel, message: string, detail?: string) => void
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
  private readonly serverPublicKey: Uint8Array
  private lastInboundAt: number | null = null
  private lastSocketClosedAt: number | null = null
  private constructionCount = 0
  private dialStartedAt = 0

  constructor(private readonly options: SocketFactoryOptions) {
    this.serverPublicKey = publicKeyFromBase64(options.serverPublicKeyB64)
  }

  open(): RpcClientSocketSession {
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
      endpoint: this.options.endpoint,
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
