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
import { ClientRequestAborts } from './client-request-aborts'

export type RequestContext = {
  clientId: number
  isStale: () => boolean
  signal?: AbortSignal
}

export type MethodHandler = (
  params: Record<string, unknown>,
  context: RequestContext
) => Promise<unknown>

export type NotificationHandler = (params: Record<string, unknown>, context: RequestContext) => void

type RelayClient = {
  id: number
  decoder: FrameDecoder
  write: (data: Buffer) => void
  nextOutgoingSeq: number
  highestReceivedSeq: number
  generation: number
  closed: boolean
}

export class RelayDispatcher {
  private readonly primaryClient: RelayClient
  private readonly clients = new Map<number, RelayClient>()
  private requestHandlers = new Map<string, MethodHandler>()
  private notificationHandlers = new Map<string, NotificationHandler>()
  private readonly requestAborts = new ClientRequestAborts()
  private clientDetachListeners = new Set<(clientId: number) => void>()
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  private nextClientId = 1

  constructor(write: (data: Buffer) => void) {
    this.primaryClient = this.createClient(write)
    this.clients.set(this.primaryClient.id, this.primaryClient)
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
  // up - causing the client's unacked-timeout checker to accumulate stale
  // timestamps that could eventually fire a false connection-dead signal.
  setWrite(write: (data: Buffer) => void): void {
    this.requestAborts.abortClient(this.primaryClient.id)
    this.primaryClient.write = write
    this.primaryClient.closed = false
    this.resetClient(this.primaryClient)
  }

  // Why: in-flight mutating requests must become stale when the active client
  // disconnects even if no replacement has connected yet. Otherwise a late
  // pty.spawn/fs.watch completion can create remote state nobody can own.
  invalidateClient(): void {
    this.requestAborts.abortClient(this.primaryClient.id)
    this.primaryClient.generation++
    this.primaryClient.closed = true
    this.notifyClientDetached(this.primaryClient.id)
  }

  // Why: synced remote workspaces can have more than one Orca client attached
  // to the same relay. Frame sequence numbers and JSON-RPC request ids are per
  // SSH channel, so each socket client needs independent protocol state.
  attachClient(write: (data: Buffer) => void): number {
    const client = this.createClient(write)
    this.clients.set(client.id, client)
    return client.id
  }

  detachClient(clientId: number): void {
    const client = this.clients.get(clientId)
    if (!client || client === this.primaryClient) {
      return
    }
    this.requestAborts.abortClient(clientId)
    client.generation++
    client.closed = true
    this.clients.delete(clientId)
    this.notifyClientDetached(clientId)
  }

  feedClient(clientId: number, data: Buffer): void {
    const client = this.clients.get(clientId)
    if (!client) {
      return
    }
    this.feedForClient(client, data)
  }

  onRequest(method: string, handler: MethodHandler): void {
    this.requestHandlers.set(method, handler)
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler)
  }

  onClientDetached(listener: (clientId: number) => void): () => void {
    this.clientDetachListeners.add(listener)
    return () => this.clientDetachListeners.delete(listener)
  }

  feed(data: Buffer): void {
    this.feedForClient(this.primaryClient, data)
  }

  private feedForClient(client: RelayClient, data: Buffer): void {
    if (this.disposed) {
      return
    }
    try {
      client.decoder.feed(data)
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
    for (const client of this.clients.values()) {
      this.sendFrame(client, msg)
    }
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

  private createClient(write: (data: Buffer) => void): RelayClient {
    const id = this.nextClientId++
    const client: RelayClient = {
      id,
      decoder: new FrameDecoder((frame) => this.handleFrame(client, frame)),
      write,
      nextOutgoingSeq: 1,
      highestReceivedSeq: 0,
      generation: 0,
      closed: false
    }
    return client
  }

  private resetClient(client: RelayClient): void {
    client.nextOutgoingSeq = 1
    client.highestReceivedSeq = 0
    client.decoder.reset()
    client.generation++
    client.closed = false
  }

  private handleFrame(client: RelayClient, frame: DecodedFrame): void {
    if (frame.id > client.highestReceivedSeq) {
      client.highestReceivedSeq = frame.id
    }

    if (frame.type === MessageType.KeepAlive) {
      return
    }

    if (frame.type === MessageType.Regular) {
      try {
        const msg = parseJsonRpcMessage(frame.payload)
        this.handleMessage(client, msg)
      } catch (err) {
        process.stderr.write(
          `[relay] Parse error: ${err instanceof Error ? err.message : String(err)}\n`
        )
      }
    }
  }

  private handleMessage(
    client: RelayClient,
    msg: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse
  ): void {
    if ('id' in msg && 'method' in msg) {
      void this.handleRequest(client, msg as JsonRpcRequest)
    } else if ('method' in msg && !('id' in msg)) {
      this.handleNotification(client, msg as JsonRpcNotification)
    }
  }

  private async handleRequest(client: RelayClient, req: JsonRpcRequest): Promise<void> {
    const handler = this.requestHandlers.get(req.method)
    if (!handler) {
      this.sendResponse(client, req.id, undefined, {
        code: -32601,
        message: `Method not found: ${req.method}`
      })
      return
    }

    // Why: capture this client's generation before the async handler runs.
    // If that client disconnects while the handler is in flight, the response
    // belongs to a dead request-id space and mutating work may need cleanup.
    const gen = client.generation
    const { key: abortKey, controller: abortController } = this.requestAborts.create(
      client.id,
      req.id
    )
    const context: RequestContext = {
      clientId: client.id,
      isStale: () =>
        client.generation !== gen || !this.clients.has(client.id) || abortController.signal.aborted,
      signal: abortController.signal
    }
    try {
      const result = await handler(req.params ?? {}, context)
      if (context.isStale()) {
        return
      }
      this.sendResponse(client, req.id, result)
    } catch (err) {
      if (context.isStale()) {
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      const code = (err as { code?: number }).code ?? -32000
      this.sendResponse(client, req.id, undefined, { code, message })
    } finally {
      this.requestAborts.delete(abortKey)
    }
  }

  private handleNotification(client: RelayClient, notif: JsonRpcNotification): void {
    if (notif.method === 'rpc.cancel') {
      const id = Number((notif.params ?? {}).id)
      const controller = this.requestAborts.get(client.id, id)
      controller?.abort()
      return
    }
    const handler = this.notificationHandlers.get(notif.method)
    if (handler) {
      const gen = client.generation
      handler(notif.params ?? {}, {
        clientId: client.id,
        isStale: () => client.generation !== gen || !this.clients.has(client.id)
      })
    }
  }

  private sendResponse(
    client: RelayClient,
    id: number,
    result?: unknown,
    error?: { code: number; message: string; data?: unknown }
  ): void {
    const msg: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      ...(error ? { error } : { result: result ?? null })
    }
    this.sendFrame(client, msg)
  }

  private sendFrame(
    client: RelayClient,
    msg: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification
  ): void {
    if (this.disposed || client.closed) {
      return
    }
    const seq = client.nextOutgoingSeq++
    const frame = encodeJsonRpcFrame(msg, seq, client.highestReceivedSeq)
    this.writeFrame(client, frame)
  }

  private startKeepalive(): void {
    this.keepaliveTimer = setInterval(() => {
      if (this.disposed) {
        return
      }
      for (const client of this.clients.values()) {
        if (client.closed) {
          continue
        }
        const seq = client.nextOutgoingSeq++
        const frame = encodeKeepAliveFrame(seq, client.highestReceivedSeq)
        this.writeFrame(client, frame)
      }
    }, KEEPALIVE_SEND_MS)
    // Why: without unref, the keepalive interval keeps the event loop alive
    // even when the relay should be winding down (e.g. after stdin ends and
    // all PTYs have exited). unref lets the process exit naturally.
    this.keepaliveTimer.unref()
  }

  private writeFrame(client: RelayClient, frame: Buffer): void {
    try {
      client.write(frame)
    } catch (err) {
      client.closed = true
      client.generation++
      if (client !== this.primaryClient) {
        this.clients.delete(client.id)
        this.notifyClientDetached(client.id)
      }
      process.stderr.write(
        `[relay] Client write failed: ${err instanceof Error ? err.message : String(err)}\n`
      )
    }
  }

  private notifyClientDetached(clientId: number): void {
    for (const listener of this.clientDetachListeners) {
      try {
        listener(clientId)
      } catch (err) {
        process.stderr.write(
          `[relay] Client detach listener failed: ${err instanceof Error ? err.message : String(err)}\n`
        )
      }
    }
  }
}
