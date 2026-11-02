import type { PairedE2EEFramingPolicy } from '../../../src/shared/paired-e2ee-framing-policy'
import { createDirectE2EEFramingPolicy } from './direct-e2ee-framing-policy'
import { publicKeyFromBase64 } from './e2ee'
import { RpcClientSocketSession } from './rpc-client-socket-session'
import { redactSocketEndpoint } from './socket-event-debug'
import type { ConnectionLogEmitter, ConnectionState, RpcResponse } from './types'

type SocketFactoryOptions = {
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
  private readonly framingPolicy: PairedE2EEFramingPolicy
  private lastInboundAt: number | null = null
  private lastSocketClosedAt: number | null = null
  private constructionCount = 0
  private dialStartedAt = 0

  constructor(private readonly options: SocketFactoryOptions) {
    // Why: an invalid pairing key fails construction, not every dial.
    publicKeyFromBase64(options.serverPublicKeyB64)
    this.framingPolicy = createDirectE2EEFramingPolicy(options.serverPublicKeyB64)
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
      serverPublicKeyB64: this.options.serverPublicKeyB64,
      framingPolicy: this.framingPolicy,
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
