import {
  FrameDecoder,
  MessageType,
  encodeJsonRpcFrame,
  encodeKeepAliveFrame,
  parseJsonRpcMessage,
  KEEPALIVE_SEND_MS,
  TIMEOUT_MS,
  type DecodedFrame,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcNotification
} from './relay-protocol'

export type MultiplexerTransport = {
  write: (data: Buffer) => void
  onData: (cb: (data: Buffer) => void) => void
  onClose: (cb: () => void) => void
  close?: () => void
}

type PendingRequest = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type NotificationHandler = (method: string, params: Record<string, unknown>) => void

const REQUEST_TIMEOUT_MS = 30_000

export class SshChannelMultiplexer {
  private decoder: FrameDecoder
  private transport: MultiplexerTransport
  private nextRequestId = 1
  private nextOutgoingSeq = 1
  private highestReceivedSeq = 0
  private highestAckedBySelf = 0
  private lastReceivedAt = Date.now()
  private pendingRequests = new Map<number, PendingRequest>()
  private notificationHandlers: NotificationHandler[] = []
  private disposeHandlers: ((reason: 'shutdown' | 'connection_lost') => void)[] = []
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private timeoutTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  // Track the oldest unacked outgoing message timestamp
  private unackedTimestamps = new Map<number, number>()

  constructor(transport: MultiplexerTransport) {
    this.transport = transport

    this.decoder = new FrameDecoder(
      (frame) => this.handleFrame(frame),
      (err) => this.handleProtocolError(err)
    )

    transport.onData((data) => {
      if (this.disposed) {
        return
      }
      this.lastReceivedAt = Date.now()
      this.decoder.feed(data)
    })

    transport.onClose(() => {
      this.dispose('connection_lost')
    })

    if (this.disposed) {
      return
    }
    this.startKeepalive()
    this.startTimeoutCheck()
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.push(handler)
    return () => {
      const idx = this.notificationHandlers.indexOf(handler)
      if (idx !== -1) {
        this.notificationHandlers.splice(idx, 1)
      }
    }
  }

  // Why: the session needs to know when the relay channel dies so it can
  // auto-reconnect. Without this, a relay channel close (e.g. --connect
  // bridge exits) leaves the session in 'ready' state with a dead mux
  // and no recovery path — the SSH connection stays up so onStateChange
  // never fires the reconnect logic.
  onDispose(handler: (reason: 'shutdown' | 'connection_lost') => void): () => void {
    this.disposeHandlers.push(handler)
    return () => {
      const idx = this.disposeHandlers.indexOf(handler)
      if (idx !== -1) {
        this.disposeHandlers.splice(idx, 1)
      }
    }
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   */
  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) {
      throw new Error('Multiplexer disposed')
    }

    const id = this.nextRequestId++
    const msg: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {})
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Request "${method}" timed out after ${REQUEST_TIMEOUT_MS}ms`))
      }, REQUEST_TIMEOUT_MS)

      this.pendingRequests.set(id, { resolve, reject, timer })
      this.sendMessage(msg)
    })
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  notify(method: string, params?: Record<string, unknown>): void {
    if (this.disposed) {
      return
    }

    const msg: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {})
    }

    this.sendMessage(msg)
  }

  dispose(reason: 'shutdown' | 'connection_lost' = 'shutdown'): void {
    if (this.disposed) {
      return
    }
    console.warn(
      `[ssh-mux] Disposing multiplexer (reason: ${reason})`,
      new Error('dispose trace').stack
    )
    this.disposed = true

    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
    if (this.timeoutTimer) {
      clearInterval(this.timeoutTimer)
      this.timeoutTimer = null
    }

    // Why: the renderer uses the error code to distinguish temporary disconnects
    // (show reconnection overlay) from permanent shutdown (show error toast).
    const errorMessage =
      reason === 'connection_lost' ? 'SSH connection lost, reconnecting...' : 'Multiplexer disposed'
    const errorCode = reason === 'connection_lost' ? 'CONNECTION_LOST' : 'DISPOSED'

    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      const err = new Error(errorMessage) as Error & { code: string }
      err.code = errorCode
      pending.reject(err)
      this.pendingRequests.delete(id)
    }

    this.unackedTimestamps.clear()
    this.decoder.reset()
    this.transport.close?.()

    for (const handler of this.disposeHandlers) {
      try {
        handler(reason)
      } catch {
        // Don't let a handler error prevent other handlers from running
      }
    }
    this.disposeHandlers.length = 0
  }

  isDisposed(): boolean {
    return this.disposed
  }

  // ── Private ───────────────────────────────────────────────────────

  private sendMessage(msg: JsonRpcMessage): void {
    const seq = this.nextOutgoingSeq++
    const frame = encodeJsonRpcFrame(msg, seq, this.highestReceivedSeq)
    this.unackedTimestamps.set(seq, Date.now())
    this.transport.write(frame)
  }

  private sendKeepAlive(): void {
    if (this.disposed) {
      return
    }
    const seq = this.nextOutgoingSeq++
    const frame = encodeKeepAliveFrame(seq, this.highestReceivedSeq)
    this.unackedTimestamps.set(seq, Date.now())
    this.transport.write(frame)
  }

  private handleFrame(frame: DecodedFrame): void {
    // Update ack tracking
    if (frame.id > this.highestReceivedSeq) {
      this.highestReceivedSeq = frame.id
    }

    // Process ack from remote: discard timestamps for acked messages
    if (frame.ack > this.highestAckedBySelf) {
      for (let i = this.highestAckedBySelf + 1; i <= frame.ack; i++) {
        this.unackedTimestamps.delete(i)
      }
      this.highestAckedBySelf = frame.ack
    }

    if (frame.type === MessageType.KeepAlive) {
      return
    }

    if (frame.type === MessageType.Regular) {
      try {
        const msg = parseJsonRpcMessage(frame.payload)
        this.handleMessage(msg)
      } catch (err) {
        this.handleProtocolError(err)
      }
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if ('id' in msg && ('result' in msg || 'error' in msg)) {
      this.handleResponse(msg as JsonRpcResponse)
    } else if ('method' in msg && !('id' in msg)) {
      this.handleNotification(msg as JsonRpcNotification)
    }
    // Requests from relay to client are not expected in Phase 2
  }

  private handleResponse(msg: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(msg.id)
    if (!pending) {
      return
    }

    clearTimeout(pending.timer)
    this.pendingRequests.delete(msg.id)

    if (msg.error) {
      const err = new Error(msg.error.message)
      Object.defineProperty(err, 'code', { value: msg.error.code })
      Object.defineProperty(err, 'data', { value: msg.error.data })
      pending.reject(err)
    } else {
      pending.resolve(msg.result)
    }
  }

  private handleNotification(msg: JsonRpcNotification): void {
    const params = msg.params ?? {}
    // Why: handlers may unsubscribe during iteration (via the returned disposer
    // from onNotification), which splices the live array and skips the next handler.
    // Iterating a snapshot prevents that.
    const snapshot = Array.from(this.notificationHandlers)
    for (const handler of snapshot) {
      handler(msg.method, params)
    }
  }

  private startKeepalive(): void {
    this.keepaliveTimer = setInterval(() => {
      this.sendKeepAlive()
    }, KEEPALIVE_SEND_MS)
  }

  private startTimeoutCheck(): void {
    this.timeoutTimer = setInterval(() => {
      if (this.disposed) {
        return
      }

      const now = Date.now()
      const noDataReceived = now - this.lastReceivedAt > TIMEOUT_MS

      // Check oldest unacked message
      let oldestUnacked = Infinity
      for (const ts of this.unackedTimestamps.values()) {
        if (ts < oldestUnacked) {
          oldestUnacked = ts
        }
      }
      const oldestUnackedStale = oldestUnacked !== Infinity && now - oldestUnacked > TIMEOUT_MS

      // Connection considered dead when BOTH conditions met
      if (noDataReceived && oldestUnackedStale) {
        this.handleProtocolError(new Error('Connection timed out (no ack received)'))
      }
    }, KEEPALIVE_SEND_MS)
  }

  private handleProtocolError(err: unknown): void {
    console.warn(`[ssh-mux] Protocol error: ${err instanceof Error ? err.message : String(err)}`)
    this.dispose('connection_lost')
  }
}
