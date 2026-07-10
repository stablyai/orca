/* eslint-disable max-lines -- Why: the relay protocol dispatcher keeps client
   routing, request cancellation, and framing state together. */
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

/** Sink write. Returning literal `false` signals saturation (Node stream
 * semantics); `void`/`true` mean the frame was accepted. */
export type RelayClientWrite = (data: Buffer) => boolean | void

export type RelayClientSinkOptions = {
  /** One-shot: invoke `cb` once when the sink can accept more data again
   * (stream 'drain'), or when the sink is permanently dead (error/close) so
   * bulk senders waiting on it never hang. */
  waitWriteDrain?: (cb: () => void) => void
}

type RelayClient = {
  id: number
  decoder: FrameDecoder
  write: RelayClientWrite
  waitWriteDrain?: (cb: () => void) => void
  /** Pending resolvers for bulk sends stalled on sink saturation. Flushed on
   * drain, write failure, detach, setWrite, and dispose so no pump hangs. */
  drainWaiters: Set<() => void>
  /** Serializes bulk-lane sends per client so at most one bulk frame is
   * admitted past the sink's high-water mark at a time. */
  bulkChain: Promise<void>
  nextOutgoingSeq: number
  highestReceivedSeq: number
  generation: number
  closed: boolean
}

type PendingRelayRequest = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const RELAY_TO_CLIENT_REQUEST_TIMEOUT_MS = 30_000

export class RelayDispatcher {
  private readonly primaryClient: RelayClient
  private readonly clients = new Map<number, RelayClient>()
  private requestHandlers = new Map<string, MethodHandler>()
  private notificationHandlers = new Map<string, NotificationHandler>()
  private readonly requestAborts = new ClientRequestAborts()
  private pendingRelayRequests = new Map<number, PendingRelayRequest>()
  private clientDetachListeners = new Set<(clientId: number) => void>()
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  private nextClientId = 1
  private nextRequestId = 1

  constructor(write: RelayClientWrite, sinkOptions?: RelayClientSinkOptions) {
    this.primaryClient = this.createClient(write, sinkOptions)
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
  setWrite(write: RelayClientWrite, sinkOptions?: RelayClientSinkOptions): void {
    this.requestAborts.abortClient(this.primaryClient.id)
    this.primaryClient.write = write
    this.primaryClient.waitWriteDrain = sinkOptions?.waitWriteDrain
    this.primaryClient.closed = false
    // Why: the saturated sink the waiters were parked on no longer exists;
    // wake stalled bulk senders so they re-evaluate against the new sink.
    this.flushDrainWaiters(this.primaryClient)
    this.resetClient(this.primaryClient)
  }

  // Why: in-flight mutating requests must become stale when the active client
  // disconnects even if no replacement has connected yet. Otherwise a late
  // pty.spawn/fs.watch completion can create remote state nobody can own.
  invalidateClient(): void {
    this.requestAborts.abortClient(this.primaryClient.id)
    this.primaryClient.generation++
    this.primaryClient.closed = true
    this.flushDrainWaiters(this.primaryClient)
    this.notifyClientDetached(this.primaryClient.id)
  }

  // Why: synced remote workspaces can have more than one Orca client attached
  // to the same relay. Frame sequence numbers and JSON-RPC request ids are per
  // SSH channel, so each socket client needs independent protocol state.
  attachClient(write: RelayClientWrite, sinkOptions?: RelayClientSinkOptions): number {
    const client = this.createClient(write, sinkOptions)
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
    this.flushDrainWaiters(client)
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

  /**
   * Bulk-lane notification. Sends are serialized per client and the returned
   * promise resolves only after the sink accepted the frame without reporting
   * saturation (or the client went away). Bulk producers (file streams) await
   * this between frames so interactive frames (pty.data echo) never queue
   * behind an unbounded backlog on the shared SSH channel.
   *
   * With `clientId`, the frame goes only to that client — stream chunks have
   * exactly one consumer, and broadcasting them would let one slow secondary
   * client stall everyone. A missing/closed target resolves immediately; the
   * caller's staleness check owns aborting the stream.
   */
  notifyBulk(
    method: string,
    params?: Record<string, unknown>,
    opts?: { clientId?: number }
  ): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }
    const msg: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {})
    }
    const targets =
      opts?.clientId !== undefined
        ? [this.clients.get(opts.clientId)].filter((c): c is RelayClient => c !== undefined)
        : Array.from(this.clients.values())
    const waits: Promise<void>[] = []
    for (const client of targets) {
      if (client.closed) {
        continue
      }
      // Why: the frame is encoded inside the chain step, not at call time —
      // sequence numbers must be assigned in actual write order.
      const step = client.bulkChain.then(() => {
        if (this.disposed || client.closed) {
          return
        }
        const accepted = this.sendFrame(client, msg)
        if (accepted === false) {
          return this.waitForClientDrain(client)
        }
        return undefined
      })
      client.bulkChain = step.catch(() => {})
      waits.push(step)
    }
    if (waits.length === 0) {
      return Promise.resolve()
    }
    return Promise.all(waits).then(() => {})
  }

  private waitForClientDrain(client: RelayClient): Promise<void> {
    if (this.disposed || client.closed || !client.waitWriteDrain) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) {
          return
        }
        settled = true
        client.drainWaiters.delete(finish)
        resolve()
      }
      client.drainWaiters.add(finish)
      try {
        client.waitWriteDrain!(finish)
      } catch {
        finish()
      }
    })
  }

  private flushDrainWaiters(client: RelayClient): void {
    for (const waiter of Array.from(client.drainWaiters)) {
      waiter()
    }
  }

  requestPrimary(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ): Promise<unknown> {
    return this.requestClient(this.primaryClient.id, method, params, options)
  }

  requestAnyClient(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number; excludeClientId?: number }
  ): Promise<unknown> {
    const candidates = Array.from(this.clients.values()).filter(
      (client) => !client.closed && client.id !== options?.excludeClientId
    )
    // Why: detached relays keep the synthetic primary client object around even
    // though the owning Orca is attached through a Unix-socket client. Prefer a
    // real attached client so remote `orca` shims do not forward to dead stdout.
    const target = candidates.find((client) => client !== this.primaryClient) ?? candidates[0]
    if (!target) {
      return Promise.reject(new Error('No owning Orca client is connected to the relay'))
    }
    return this.requestClient(target.id, method, params, options)
  }

  private requestClient(
    clientId: number,
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ): Promise<unknown> {
    const client = this.clients.get(clientId)
    if (this.disposed || !client || client.closed) {
      return Promise.reject(new Error('Relay client is not connected'))
    }
    const id = this.nextRequestId++
    const msg: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {})
    }
    const timeoutMs = options?.timeoutMs ?? RELAY_TO_CLIENT_REQUEST_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRelayRequests.delete(id)
        reject(new Error(`Request "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pendingRelayRequests.set(id, { resolve, reject, timer })
      this.sendFrame(client, msg)
    })
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
    for (const [id, pending] of this.pendingRelayRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Relay dispatcher disposed'))
      this.pendingRelayRequests.delete(id)
    }
    // Why: dispose means this relay instance cannot send responses anymore;
    // abort in-flight request work so stale SSH-side scans/watchers release.
    this.requestAborts.abortAll()
    for (const client of this.clients.values()) {
      this.flushDrainWaiters(client)
    }
  }

  private createClient(write: RelayClientWrite, sinkOptions?: RelayClientSinkOptions): RelayClient {
    const id = this.nextClientId++
    const client: RelayClient = {
      id,
      decoder: new FrameDecoder((frame) => this.handleFrame(client, frame)),
      write,
      waitWriteDrain: sinkOptions?.waitWriteDrain,
      drainWaiters: new Set(),
      bulkChain: Promise.resolve(),
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
    } else if ('id' in msg && ('result' in msg || 'error' in msg)) {
      this.handleResponse(msg as JsonRpcResponse)
    } else if ('method' in msg && !('id' in msg)) {
      this.handleNotification(client, msg as JsonRpcNotification)
    }
  }

  private handleResponse(msg: JsonRpcResponse): void {
    const pending = this.pendingRelayRequests.get(msg.id)
    if (!pending) {
      return
    }
    clearTimeout(pending.timer)
    this.pendingRelayRequests.delete(msg.id)
    if (msg.error) {
      const error = new Error(msg.error.message) as Error & { code?: number; data?: unknown }
      error.code = msg.error.code
      error.data = msg.error.data
      pending.reject(error)
      return
    }
    pending.resolve(msg.result)
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
  ): boolean | void {
    if (this.disposed || client.closed) {
      return
    }
    const seq = client.nextOutgoingSeq++
    const frame = encodeJsonRpcFrame(msg, seq, client.highestReceivedSeq)
    return this.writeFrame(client, frame)
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

  private writeFrame(client: RelayClient, frame: Buffer): boolean | void {
    try {
      return client.write(frame)
    } catch (err) {
      client.closed = true
      client.generation++
      this.requestAborts.abortClient(client.id)
      this.flushDrainWaiters(client)
      // Why: a write throw means this frame (possibly pty.data or pty.exit) was
      // lost with no resend — the framing carries seq/ack but no retransmit
      // buffer. Detach so the owning Orca's reconnect + PTY-reattach path runs
      // promptly (regenerating dropped pty.data from the replay buffer and pane
      // death via reattach-not-found), instead of silently dropping frames until
      // the ~20s keepalive timeout notices. The primary client stays in the map
      // (its object is reused across setWrite reconnects) but detach listeners
      // must still fire, exactly as invalidateClient() does for stdin/stdout
      // death — this makes the socket-write-throw path consistent with those.
      if (client !== this.primaryClient) {
        this.clients.delete(client.id)
      }
      this.notifyClientDetached(client.id)
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
