/* eslint-disable max-lines -- Why: the SSH relay protocol state machine keeps
   request, notification, keepalive, and cancellation semantics paired. */
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
  cleanup: () => void
}

export type NotificationHandler = (method: string, params: Record<string, unknown>) => void
export type MethodNotificationHandler = (params: Record<string, unknown>) => void

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
  // Why: per-method dispatch map keeps streaming consumers (fs.streamChunk,
  // fs.streamEnd, fs.streamError) from accreting string-match logic in the
  // generic notification listener that already serves fs.changed.
  private methodNotificationHandlers = new Map<string, Set<MethodNotificationHandler>>()
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

  onNotificationByMethod(method: string, handler: MethodNotificationHandler): () => void {
    let set = this.methodNotificationHandlers.get(method)
    if (!set) {
      set = new Set()
      this.methodNotificationHandlers.set(method, set)
    }
    set.add(handler)
    return () => {
      const current = this.methodNotificationHandlers.get(method)
      if (!current) {
        return
      }
      current.delete(handler)
      if (current.size === 0) {
        this.methodNotificationHandlers.delete(method)
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
  async request(
    method: string,
    params?: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<unknown> {
    if (this.disposed) {
      throw new Error('Multiplexer disposed')
    }
    if (options?.signal?.aborted) {
      const error = new Error(`Request "${method}" was cancelled`) as Error & { name: string }
      error.name = 'AbortError'
      throw error
    }

    const id = this.nextRequestId++
    const msg: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {})
    }
    const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS

    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>
      const cleanup = (): void => {
        clearTimeout(timer)
        if (options?.signal) {
          options.signal.removeEventListener('abort', onAbort)
        }
      }
      const onAbort = (): void => {
        const pending = this.pendingRequests.get(id)
        if (!pending) {
          return
        }
        pending.cleanup()
        this.pendingRequests.delete(id)
        // Why: Space scans can run long on SSH hosts. Let the relay stop its
        // local filesystem work instead of only dropping the client promise.
        this.notify('rpc.cancel', { id })
        const error = new Error(`Request "${method}" was cancelled`) as Error & { name: string }
        error.name = 'AbortError'
        pending.reject(error)
      }
      timer = setTimeout(() => {
        const pending = this.pendingRequests.get(id)
        if (pending) {
          pending.cleanup()
          // Why: request timeouts should stop relay-side long-running work,
          // not just detach the client from the eventual response.
          this.notify('rpc.cancel', { id })
        }
        this.pendingRequests.delete(id)
        reject(new Error(`Request "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      if (options?.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true })
      }
      this.pendingRequests.set(id, { resolve, reject, timer, cleanup })
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
      pending.cleanup()
      const err = new Error(errorMessage) as Error & { code: string }
      err.code = errorCode
      pending.reject(err)
      this.pendingRequests.delete(id)
    }

    this.unackedTimestamps.clear()
    this.methodNotificationHandlers.clear()
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
    try {
      this.transport.write(frame)
    } catch (err) {
      // Why: a remote reboot can make the SSH channel's stdin throw EPIPE
      // from a timer/request path. Scope it to this mux instead of letting
      // the Electron main process treat it as an uncaught exception.
      this.handleProtocolError(err)
    }
  }

  private sendKeepAlive(): void {
    if (this.disposed) {
      return
    }
    const seq = this.nextOutgoingSeq++
    const frame = encodeKeepAliveFrame(seq, this.highestReceivedSeq)
    this.unackedTimestamps.set(seq, Date.now())
    try {
      this.transport.write(frame)
    } catch (err) {
      // Why: keepalive runs on an interval; without catching transport
      // write failures here, a dead SSH host can terminate the whole app.
      this.handleProtocolError(err)
    }
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

    pending.cleanup()
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
    // from onNotification / onNotificationByMethod), which mutates the live
    // collection and skips the next handler. Iterating a snapshot prevents that.
    const snapshot = Array.from(this.notificationHandlers)
    for (const handler of snapshot) {
      handler(msg.method, params)
    }
    const methodHandlers = this.methodNotificationHandlers.get(msg.method)
    if (methodHandlers && methodHandlers.size > 0) {
      const methodSnapshot = Array.from(methodHandlers)
      for (const handler of methodSnapshot) {
        handler(params)
      }
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
