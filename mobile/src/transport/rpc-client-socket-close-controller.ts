import type { RpcClientAuthenticationRetry } from './rpc-client-authentication-retry'
import type { RpcClientConnectionState } from './rpc-client-connection-state'
import type { RpcClientReconnectSchedule } from './rpc-client-reconnect-schedule'
import type { RpcClientRequestTracker } from './rpc-client-request-tracker'
import type { RpcClientSocketFactory } from './rpc-client-socket-factory'
import type { RpcClientSocketSession } from './rpc-client-socket-session'
import type { RpcClientStreamRegistry } from './rpc-client-stream-registry'
import { RpcSynthesizedCloseIndex } from './rpc-socket-close-evidence'

const UNAUTHORIZED_CLOSE_CODE = 4001

type SocketCloseControllerOptions = {
  connectionState: RpcClientConnectionState
  reconnect: RpcClientReconnectSchedule
  requests: RpcClientRequestTracker
  streams: RpcClientStreamRegistry
  socketFactory: RpcClientSocketFactory
  authenticationRetry: RpcClientAuthenticationRetry
  getCurrentSession: () => RpcClientSocketSession | null
  clearCurrentSession: () => void
  getAuthenticationGeneration: () => number
  isIntentionallyClosed: () => boolean
  stopLiveness: (session: RpcClientSocketSession) => void
  emitWarning: (message: string, detail: string) => void
}

export class RpcClientSocketCloseController {
  private readonly synthesizedCloses = new RpcSynthesizedCloseIndex()

  constructor(private readonly options: SocketCloseControllerOptions) {}

  forceClose(session: RpcClientSocketSession): void {
    session.close()
    if (this.options.getCurrentSession() === session) {
      this.synthesizedCloses.remember(session.socket, this.options.getAuthenticationGeneration())
      this.handle(session)
    }
  }

  handle(session: RpcClientSocketSession, closeCode?: number): void {
    if (this.options.getCurrentSession() !== session) {
      if (
        this.synthesizedCloses.takeUnauthorized(
          session.socket,
          closeCode,
          this.options.getAuthenticationGeneration(),
          UNAUTHORIZED_CLOSE_CODE
        )
      ) {
        this.options.authenticationRetry.reject('Unauthorized — pairing may be revoked', true)
        return
      }
      console.log('[net] handleSocketClosed STALE — ignoring (ws already swapped)', {
        state: this.options.connectionState.get(),
        attempt: this.options.reconnect.getAttempt()
      })
      return
    }
    this.options.socketFactory.noteClosed()
    session.clearTimers()
    session.clearKey()
    this.options.clearCurrentSession()
    this.options.streams.markForReplay()
    this.options.stopLiveness(session)
    if (this.options.isIntentionallyClosed()) {
      console.log('[net] handleSocketClosed — intentional close')
      this.options.connectionState.publish('disconnected')
      this.options.requests.rejectAll('Connection closed', { deliveryUnknown: true })
      return
    }
    if (closeCode === UNAUTHORIZED_CLOSE_CODE) {
      console.log('[net] handleSocketClosed — unauthorized close code', {
        attempt: this.options.reconnect.getAttempt()
      })
      this.options.authenticationRetry.reject('Unauthorized — pairing may be revoked')
      return
    }
    console.log('[net] handleSocketClosed → reconnect', {
      pendingCount: this.options.requests.size(),
      streamCount: this.options.streams.size(),
      attempt: this.options.reconnect.getAttempt()
    })
    this.options.emitWarning('WebSocket closed', 'Will attempt to reconnect')
    this.options.requests.rejectAll('Connection interrupted', { deliveryUnknown: true })
    this.options.connectionState.publish('reconnecting')
    this.options.reconnect.schedule()
  }
}
