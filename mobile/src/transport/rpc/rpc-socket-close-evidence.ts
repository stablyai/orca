import { describeSocketEvent } from '../../diagnostics/connection/socket-event-debug'
import type { ConnectionState } from '../connection/connection-state'

type SocketCloseLogOptions = {
  event: unknown
  state: ConnectionState
  attempt: number
  intentionallyClosed: boolean
  endpoint: string
  constructedAt: number
  authenticated: boolean
  lastInboundAt: number | null
}

export class RpcSynthesizedCloseIndex {
  private readonly authenticationBySocket = new WeakMap<WebSocket, number>()

  remember(socket: WebSocket, authenticationGeneration: number): void {
    this.authenticationBySocket.set(socket, authenticationGeneration)
  }

  takeUnauthorized(
    socket: WebSocket,
    closeCode: number | undefined,
    authenticationGeneration: number,
    unauthorizedCloseCode: number
  ): boolean {
    const synthesizedAtGeneration = this.authenticationBySocket.get(socket)
    this.authenticationBySocket.delete(socket)
    return (
      closeCode === unauthorizedCloseCode && synthesizedAtGeneration === authenticationGeneration
    )
  }
}

export function isStaleRpcSocketEvent(
  current: WebSocket | null,
  opening: WebSocket,
  eventName: string,
  state: ConnectionState,
  attempt: number
): boolean {
  if (current === opening) {
    return false
  }
  console.log('[net] stale ws event ignored', { eventName, state, attempt })
  return true
}

export function logRpcSocketClose(options: SocketCloseLogOptions): number | undefined {
  const event = options.event as { code?: number; reason?: string; wasClean?: boolean } | undefined
  const closeAt = Date.now()
  const constructToCloseMs = closeAt - options.constructedAt
  const closeEvent = describeSocketEvent(options.event)
  console.log('[net] ws.onclose', {
    code: event?.code,
    reason: event?.reason,
    wasClean: event?.wasClean,
    state: options.state,
    attempt: options.attempt,
    intentionallyClosed: options.intentionallyClosed,
    endpoint: options.endpoint,
    constructToCloseMs,
    aliveMs: options.authenticated ? constructToCloseMs : null,
    inboundIdleMs: options.lastInboundAt != null ? closeAt - options.lastInboundAt : null,
    eventKeys: closeEvent.keys,
    eventStr: closeEvent.json
  })
  return event?.code
}

/** Logs a send the socket was not ready for; true when a connected session's current socket has closed underneath it. */
export function reportUnreadyRpcSend(
  socket: WebSocket,
  evidence: { current: WebSocket | null; hasKey: boolean; state: ConnectionState }
): boolean {
  const { readyState } = socket
  console.log('[net] sendEncrypted FAILED — channel not ready', {
    hasWs: evidence.current !== null,
    readyState,
    hasKey: evidence.hasKey,
    state: evidence.state
  })
  const desynced =
    evidence.state === 'connected' && evidence.current === socket && readyState !== WebSocket.OPEN
  if (desynced) {
    console.log('[net] sendEncrypted detected ws desync — forcing reconnect', { readyState })
  }
  return desynced
}
