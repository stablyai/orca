import type { ConnectionLogEmitter } from './types'

export const RPC_SOCKET_CONNECT_TIMEOUT_MS = 12_000
export const RPC_SOCKET_HANDSHAKE_TIMEOUT_MS = 5_000
const WEBSOCKET_CONNECTING_STATE = 0

type TimeoutHandle = ReturnType<typeof setTimeout> | null

// Why: RN can leave a dial or handshake pending forever on flaky handoffs; force a reconnect instead.
export class RpcClientSocketTimeouts {
  private connectTimer: TimeoutHandle = null
  private handshakeTimer: TimeoutHandle = null

  constructor(
    private readonly options: {
      emitLog: ConnectionLogEmitter
      getReconnectAttempt: () => number
      expire: () => void
    }
  ) {}

  armConnect(isCurrentSocket: () => boolean, readyState: () => number): void {
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null
      if (!isCurrentSocket() || readyState() !== WEBSOCKET_CONNECTING_STATE) {
        return
      }
      console.log('[net] connect-timeout fired (onopen never arrived)', {
        attempt: this.options.getReconnectAttempt(),
        timeoutMs: RPC_SOCKET_CONNECT_TIMEOUT_MS
      })
      this.options.emitLog(
        'error',
        'WebSocket connect timeout',
        `No TCP/WS handshake within ${RPC_SOCKET_CONNECT_TIMEOUT_MS / 1000}s — endpoint unreachable?`,
        { code: 'connect-timeout' }
      )
      this.options.expire()
    }, RPC_SOCKET_CONNECT_TIMEOUT_MS)
  }

  armHandshake(isPending: () => boolean): void {
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null
      if (!isPending()) {
        return
      }
      console.log('[net] handshake-timeout fired (e2ee_authenticated never arrived)', {
        timeoutMs: RPC_SOCKET_HANDSHAKE_TIMEOUT_MS
      })
      this.options.emitLog(
        'error',
        'Handshake timeout',
        `No e2ee_ready/e2ee_authenticated within ${RPC_SOCKET_HANDSHAKE_TIMEOUT_MS / 1000}s`,
        { code: 'handshake-timeout' }
      )
      this.options.expire()
    }, RPC_SOCKET_HANDSHAKE_TIMEOUT_MS)
  }

  clearConnect(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
  }

  clearHandshake(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
  }

  clearAll(): void {
    this.clearConnect()
    this.clearHandshake()
  }
}
