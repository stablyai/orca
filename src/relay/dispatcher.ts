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

export type MethodHandler = (params: Record<string, unknown>) => Promise<unknown>

export type NotificationHandler = (params: Record<string, unknown>) => void

export class RelayDispatcher {
  private decoder: FrameDecoder
  private write: (data: Buffer) => void
  private requestHandlers = new Map<string, MethodHandler>()
  private notificationHandlers = new Map<string, NotificationHandler>()
  private nextOutgoingSeq = 1
  private highestReceivedSeq = 0
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  constructor(write: (data: Buffer) => void) {
    this.write = write
    this.decoder = new FrameDecoder((frame) => this.handleFrame(frame))
    this.startKeepalive()
  }

  onRequest(method: string, handler: MethodHandler): void {
    this.requestHandlers.set(method, handler)
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler)
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

    try {
      const result = await handler(req.params ?? {})
      this.sendResponse(req.id, result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const code = (err as { code?: number }).code ?? -32000
      this.sendResponse(req.id, undefined, { code, message })
    }
  }

  private handleNotification(notif: JsonRpcNotification): void {
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
