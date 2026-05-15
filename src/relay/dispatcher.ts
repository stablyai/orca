import {
  FrameDecoder,
  MessageType,
  encodeJsonRpcFrame,
  encodeKeepAliveFrame,
  parseJsonRpcMessage,
  KEEPALIVE_SEND_MS,
  type DecodedFrame,
  type JsonRpcRequest,
  type JsonRpcNotification,
  type JsonRpcResponse
} from './protocol'

export type RequestContext = {
  isStale: () => boolean
  signal?: AbortSignal
}

export type MethodHandler = (
  params: Record<string, unknown>,
  context: RequestContext
) => Promise<unknown>

export type NotificationHandler = (params: Record<string, unknown>) => void

export class RelayDispatcher {
  private decoder: FrameDecoder
  private write: (data: Buffer) => void
  private requestHandlers = new Map<string, MethodHandler>()
  private notificationHandlers = new Map<string, NotificationHandler>()
  private requestAbortControllers = new Map<number, AbortController>()
  private nextOutgoingSeq = 1
  private highestReceivedSeq = 0
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  // Why: incremented on every setWrite() call so async request handlers
  // that started before a client swap can detect that their response
  // would go to a different client and discard it instead of misrouting.
  private generation = 0

  constructor(write: (data: Buffer) => void) {
    this.write = write
    this.decoder = new FrameDecoder((frame) => this.handleFrame(frame))
    this.startKeepalive()
  }

  // Why: when a client reconnects via Unix socket, the relay must redirect
  // all outgoing frames (pty.data, keepalives, responses) to the new socket
  // instead of the original stdout. Swapping the write callback avoids
  // tearing down and reconstructing the entire dispatcher + handler tree.
  //
  // Why: sequence counters and decoder state must also reset because the new
  // client's SshChannelMultiplexer starts at seq=1. Without resetting, the
  // relay's highestReceivedSeq stays at the old client's last value, so it
  // never acks the new client's frames until the new client's seq catches
  // up — causing the client's unacked-timeout checker to accumulate stale
  // timestamps that could eventually fire a false connection-dead signal.
  setWrite(write: (data: Buffer) => void): void {
    this.abortActiveRequests()
    this.write = write
    this.nextOutgoingSeq = 1
    this.highestReceivedSeq = 0
    this.decoder.reset()
    this.generation++
  }

  // Why: in-flight mutating requests must become stale when the active client
  // disconnects even if no replacement has connected yet. Otherwise a late
  // pty.spawn/fs.watch completion can create remote state nobody can own.
  invalidateClient(): void {
    this.abortActiveRequests()
    this.generation++
  }

  onRequest(method: string, handler: MethodHandler): void {
    this.requestHandlers.set(method, handler)
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler)
  }

  private abortActiveRequests(): void {
    for (const controller of this.requestAbortControllers.values()) {
      controller.abort()
    }
    this.requestAbortControllers.clear()
  }

  feed(data: Buffer): void {
    if (this.disposed) {
      return
    }
    try {
      this.decoder.feed(data)
    } catch (err) {
      process.stderr.write(
        `[relay] Protocol error: ${err instanceof Error ? err.message : String(err)}\n`
      )
    }
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this.disposed) {
      return
    }
    const msg: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {})
    }
    this.sendFrame(msg)
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
  }

  private handleFrame(frame: DecodedFrame): void {
    if (frame.id > this.highestReceivedSeq) {
      this.highestReceivedSeq = frame.id
    }

    if (frame.type === MessageType.KeepAlive) {
      return
    }

    if (frame.type === MessageType.Regular) {
      try {
        const msg = parseJsonRpcMessage(frame.payload)
        this.handleMessage(msg)
      } catch (err) {
        process.stderr.write(
          `[relay] Parse error: ${err instanceof Error ? err.message : String(err)}\n`
        )
      }
    }
  }

  private handleMessage(msg: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    if ('id' in msg && 'method' in msg) {
      void this.handleRequest(msg as JsonRpcRequest)
    } else if ('method' in msg && !('id' in msg)) {
      this.handleNotification(msg as JsonRpcNotification)
    }
  }

  private async handleRequest(req: JsonRpcRequest): Promise<void> {
    const handler = this.requestHandlers.get(req.method)
    if (!handler) {
      this.sendResponse(req.id, undefined, {
        code: -32601,
        message: `Method not found: ${req.method}`
      })
      return
    }

    // Why: capture generation before the async handler runs. If a new
    // client connects (setWrite increments generation) while this handler
    // is in flight, the response belongs to the old client's request ID
    // space. Sending it would misroute — the new client may have issued
    // its own request with the same JSON-RPC id.
    const gen = this.generation
    const abortController = new AbortController()
    this.requestAbortControllers.set(req.id, abortController)
    const context: RequestContext = {
      isStale: () => this.generation !== gen || abortController.signal.aborted,
      signal: abortController.signal
    }
    try {
      const result = await handler(req.params ?? {}, context)
      if (this.generation !== gen || abortController.signal.aborted) {
        return
      }
      this.sendResponse(req.id, result)
    } catch (err) {
      if (this.generation !== gen || abortController.signal.aborted) {
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      const code = (err as { code?: number }).code ?? -32000
      this.sendResponse(req.id, undefined, { code, message })
    } finally {
      this.requestAbortControllers.delete(req.id)
    }
  }

  private handleNotification(notif: JsonRpcNotification): void {
    if (notif.method === 'rpc.cancel') {
      const id = Number((notif.params ?? {}).id)
      const controller = this.requestAbortControllers.get(id)
      controller?.abort()
      return
    }
    const handler = this.notificationHandlers.get(notif.method)
    if (handler) {
      handler(notif.params ?? {})
    }
  }

  private sendResponse(
    id: number,
    result?: unknown,
    error?: { code: number; message: string; data?: unknown }
  ): void {
    const msg: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      ...(error ? { error } : { result: result ?? null })
    }
    this.sendFrame(msg)
  }

  private sendFrame(msg: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification): void {
    if (this.disposed) {
      return
    }
    const seq = this.nextOutgoingSeq++
    const frame = encodeJsonRpcFrame(msg, seq, this.highestReceivedSeq)
    this.write(frame)
  }

  private startKeepalive(): void {
    this.keepaliveTimer = setInterval(() => {
      if (this.disposed) {
        return
      }
      const seq = this.nextOutgoingSeq++
      const frame = encodeKeepAliveFrame(seq, this.highestReceivedSeq)
      this.write(frame)
    }, KEEPALIVE_SEND_MS)
    // Why: without unref, the keepalive interval keeps the event loop alive
    // even when the relay should be winding down (e.g. after stdin ends and
    // all PTYs have exited). unref lets the process exit naturally.
    this.keepaliveTimer.unref()
  }
}
