/* eslint-disable max-lines -- dispatcher keeps client routing, cancellation, and framing state together */
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
import { MAX_TIMER_DELAY_MS, isSafeTimerDelayMs } from '../shared/timer-delay'
import {
  DISPATCHER_CONTROL_QUEUE_MAX_BYTES,
  DEFAULT_PRODUCER_QUEUE_MAX_BYTES,
  DispatcherClientWriter,
  type DispatcherWriterLane,
  type RelayClientSinkOptions,
  type RelayClientWrite,
  type SinkWriteSettlement
} from './dispatcher-client-writer'
import {
  LegacyRelayPublicationLedger,
  type LegacyPublicationLease
} from './legacy-relay-publication-ledger'

export type {
  RelayClientSinkOptions,
  RelayClientWrite,
  SinkWriteSettlement
} from './dispatcher-client-writer'

export type RequestContext = {
  clientId: number
  isStale: () => boolean
  signal?: AbortSignal
  sessionIdentity?: RelayClientSessionIdentity
  onResponseSettled?: (handler: (result: SinkWriteSettlement) => void) => void
}

export type RelayClientSessionIdentity = {
  principal: string
  authenticated: boolean
  allowSessionOwner: boolean
  authenticationKind: 'unproved' | 'launch-nonce' | 'endpoint-credential'
}

export type RelayClientSourceOptions = {
  pauseReads?: () => void
  resumeReads?: () => void
}

export type MethodHandler = (
  params: Record<string, unknown>,
  context: RequestContext
) => Promise<unknown>

export type NotificationHandler = (params: Record<string, unknown>, context: RequestContext) => void

type RelayClient = {
  id: number
  decoder: FrameDecoder
  writer: DispatcherClientWriter
  bulkChain: Promise<void>
  nextOutgoingSeq: number
  highestReceivedSeq: number
  generation: number
  closed: boolean
  sessionIdentity: RelayClientSessionIdentity
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
  private readonly publicationLedger = new LegacyRelayPublicationLedger()
  private pendingRelayRequests = new Map<number, PendingRelayRequest>()
  private clientDetachListeners = new Set<(clientId: number) => void>()
  private disposeListeners = new Set<() => void>()
  private legacyCapacityListeners = new Set<() => void>()
  private publicationTransactionDepth = 0
  private deferredLegacyCapacity = false
  private deferredForcedLegacyCapacity = false
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  private nextClientId = 1
  private nextRequestId = 1

  constructor(
    write: RelayClientWrite,
    sinkOptions?: RelayClientSinkOptions,
    sessionIdentity?: RelayClientSessionIdentity,
    sourceOptions?: RelayClientSourceOptions
  ) {
    this.primaryClient = this.createClient(write, sinkOptions, sessionIdentity, sourceOptions)
    this.clients.set(this.primaryClient.id, this.primaryClient)
    this.startKeepalive()
  }

  // Why: redirect outgoing frames to the reconnected socket without rebuilding the dispatcher + handler tree.
  // Why: the new client's multiplexer restarts at seq=1, so reset seq/decoder state or acks stall and fire a false connection-dead signal.
  setWrite(write: RelayClientWrite, sinkOptions?: RelayClientSinkOptions): void {
    this.requestAborts.abortClient(this.primaryClient.id)
    this.primaryClient.closed = true
    this.primaryClient.writer.close(new Error('Relay primary sink replaced'))
    this.resetClient(this.primaryClient)
    this.primaryClient.writer = this.createWriter(this.primaryClient, write, sinkOptions)
  }

  // Why: mark in-flight requests stale on disconnect so a late pty.spawn/fs.watch can't create unowned remote state.
  invalidateClient(): void {
    this.closeClient(this.primaryClient, new Error('Relay primary client invalidated'), false)
  }

  // Why: seq numbers and request ids are per SSH channel, so each attached client needs independent protocol state.
  attachClient(
    write: RelayClientWrite,
    sinkOptions?: RelayClientSinkOptions,
    sessionIdentity?: RelayClientSessionIdentity,
    sourceOptions?: RelayClientSourceOptions
  ): number {
    const client = this.createClient(write, sinkOptions, sessionIdentity, sourceOptions)
    this.clients.set(client.id, client)
    return client.id
  }

  detachClient(clientId: number): void {
    const client = this.clients.get(clientId)
    if (!client || client === this.primaryClient) {
      return
    }
    this.closeClient(client, new Error('Relay client detached'), true)
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

  onDisposed(listener: () => void): () => void {
    this.disposeListeners.add(listener)
    return () => this.disposeListeners.delete(listener)
  }

  onLegacyPtyCapacity(listener: () => void): () => void {
    this.legacyCapacityListeners.add(listener)
    return () => this.legacyCapacityListeners.delete(listener)
  }

  get legacyRetentionBelowLowWater(): boolean {
    return this.publicationLedger.belowLowWater(this.activeClientKeys())
  }

  writePrimaryBytes(data: Buffer, lane: 'control' | 'ordinary' = 'control'): boolean {
    if (this.disposed || this.primaryClient.closed) {
      return false
    }
    return this.primaryClient.writer.enqueue(lane, () => data, data.length)
  }

  maxLegacyPtyDataChars(
    params: Record<string, unknown>,
    data: string,
    limit = data.length
  ): number {
    const clients = this.activeClients()
    if (clients.length === 0) {
      return Math.min(data.length, limit)
    }
    let low = 0
    let high = Math.min(data.length, limit)
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      const msg: JsonRpcNotification = {
        jsonrpc: '2.0',
        method: 'pty.data',
        params: { ...params, data: data.slice(0, mid) }
      }
      const bytes = this.estimateFrameBytes(msg)
      if (clients.every((client) => bytes <= client.writer.producerFrameCapacity)) {
        low = mid
      } else {
        high = mid - 1
      }
    }
    return low
  }

  tryNotifyPtyData(
    params: Record<string, unknown>,
    options: { interactive?: boolean } = {}
  ): boolean {
    if (this.disposed) {
      return false
    }
    const msg: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'pty.data',
      params
    }
    return this.tryPublishToClients(
      this.activeClients(),
      msg,
      options.interactive ? 'interactive' : 'ordinary'
    )
  }

  tryNotifyPtyDataToMatchingClients(
    matchesClient: (clientId: number) => boolean,
    params: Record<string, unknown>,
    options: { interactive?: boolean } = {}
  ): boolean {
    if (this.disposed) {
      return false
    }
    return this.tryPublishToClients(
      this.activeClients().filter((client) => matchesClient(client.id)),
      { jsonrpc: '2.0', method: 'pty.data', params },
      options.interactive ? 'interactive' : 'ordinary'
    )
  }

  projectPtyDataToMatchingClients(
    matchesClient: (clientId: number) => boolean,
    params: Record<string, unknown>,
    options: { interactive?: boolean } = {}
  ): boolean {
    if (this.disposed) {
      return false
    }
    return this.projectToClients(
      this.activeClients().filter((client) => matchesClient(client.id)),
      { jsonrpc: '2.0', method: 'pty.data', params },
      options.interactive ? 'interactive' : 'ordinary'
    )
  }

  tryNotifyPtyDataToClient(
    clientId: number,
    params: Record<string, unknown>,
    onSettled: (result: SinkWriteSettlement) => void
  ): boolean {
    if (this.disposed) {
      onSettled({ ok: false, error: new Error('Relay dispatcher is disposed') })
      return false
    }
    const client = this.clients.get(clientId)
    if (!client || client.closed) {
      onSettled({ ok: false, error: new Error('Relay client is not connected') })
      return false
    }
    return this.publishToClient(
      client,
      { jsonrpc: '2.0', method: 'pty.data', params },
      'ordinary',
      onSettled
    )
  }

  tryNotifyPtyExit(params: Record<string, unknown>): boolean {
    if (this.disposed) {
      return false
    }
    return this.tryPublishToClients(
      this.activeClients(),
      {
        jsonrpc: '2.0',
        method: 'pty.exit',
        params
      },
      'ordinary'
    )
  }

  tryNotifyPtyExitToMatchingClients(
    matchesClient: (clientId: number) => boolean,
    params: Record<string, unknown>
  ): boolean {
    if (this.disposed) {
      return false
    }
    return this.tryPublishToClients(
      this.activeClients().filter((client) => matchesClient(client.id)),
      { jsonrpc: '2.0', method: 'pty.exit', params },
      'ordinary'
    )
  }

  projectPtyExitToMatchingClients(
    matchesClient: (clientId: number) => boolean,
    params: Record<string, unknown>
  ): boolean {
    if (this.disposed) {
      return false
    }
    return this.projectToClients(
      this.activeClients().filter((client) => matchesClient(client.id)),
      { jsonrpc: '2.0', method: 'pty.exit', params },
      'ordinary'
    )
  }

  tryNotifyPtyExitToClient(
    clientId: number,
    params: Record<string, unknown>,
    onSettled: (result: SinkWriteSettlement) => void
  ): boolean {
    if (this.disposed) {
      onSettled({ ok: false, error: new Error('Relay dispatcher is disposed') })
      return false
    }
    const client = this.clients.get(clientId)
    if (!client || client.closed) {
      onSettled({ ok: false, error: new Error('Relay client is not connected') })
      return false
    }
    return this.publishToClient(
      client,
      { jsonrpc: '2.0', method: 'pty.exit', params },
      'ordinary',
      onSettled
    )
  }

  producerDataBudget(
    method: string,
    paramsWithoutData: Record<string, unknown>,
    clientId?: number
  ): number {
    const targets =
      clientId === undefined
        ? this.activeClients()
        : [this.clients.get(clientId)].filter((client): client is RelayClient => !!client)
    if (targets.length === 0) {
      return Number.MAX_SAFE_INTEGER
    }
    const emptyFrameBytes = this.estimateFrameBytes({
      jsonrpc: '2.0',
      method,
      params: { ...paramsWithoutData, data: '' }
    })
    return Math.max(
      0,
      Math.min(...targets.map((client) => client.writer.producerFrameCapacity - emptyFrameBytes))
    )
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
    this.runPublicationTransaction(() => {
      for (const client of this.clients.values()) {
        if (client.closed) {
          continue
        }
        if (method === 'pty.replay') {
          this.enqueueFrame(client, msg, 'control')
          continue
        }
        if (!this.publishToClient(client, msg, 'ordinary')) {
          this.closeClient(
            client,
            new Error('Relay ordinary publication capacity exceeded'),
            client !== this.primaryClient
          )
        }
      }
    })
  }

  notifyClient(clientId: number, method: string, params?: Record<string, unknown>): void {
    this.tryNotifyClient(clientId, method, params)
  }

  tryNotifyClient(
    clientId: number,
    method: string,
    params?: Record<string, unknown>,
    onSettled: (result: SinkWriteSettlement) => void = () => {}
  ): boolean {
    if (this.disposed) {
      onSettled({ ok: false, error: new Error('Relay dispatcher is disposed') })
      return false
    }
    const client = this.clients.get(clientId)
    if (!client || client.closed) {
      onSettled({ ok: false, error: new Error('Relay client is not connected') })
      return false
    }
    return this.enqueueFrame(
      client,
      {
        jsonrpc: '2.0',
        method,
        ...(params !== undefined ? { params } : {})
      },
      'control',
      onSettled
    )
  }

  notifyControl(method: string, params?: Record<string, unknown>): void {
    if (this.disposed) {
      return
    }
    const msg: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {})
    }
    for (const client of this.activeClients()) {
      if (!this.enqueueFrame(client, msg, 'control')) {
        this.closeClient(
          client,
          new Error('Relay control publication capacity exceeded'),
          client !== this.primaryClient
        )
      }
    }
  }

  /**
   * Bulk-lane notification: sends are serialized per client and the promise
   * resolves only after the sink accepted the frame (backpressure), so bulk
   * producers await between frames and never starve interactive frames.
   * With `clientId`, targets only that client — broadcasting would let one slow secondary stall everyone.
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
      const step = client.bulkChain.then(() => this.publishBulkWhenAvailable(client, msg))
      client.bulkChain = step.catch(() => {})
      waits.push(step)
    }
    if (waits.length === 0) {
      return Promise.resolve()
    }
    return Promise.all(waits).then(() => {})
  }

  requestPrimary(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ) {
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
    // Why: prefer a real socket client over the synthetic primary so requests don't forward to a dead stdout.
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
    const timeoutMs = options?.timeoutMs ?? RELAY_TO_CLIENT_REQUEST_TIMEOUT_MS
    if (!isSafeTimerDelayMs(timeoutMs)) {
      return Promise.reject(
        new Error(`Request timeout must be an integer between 0 and ${MAX_TIMER_DELAY_MS}ms`)
      )
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
        this.pendingRelayRequests.delete(id)
        reject(new Error(`Request "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pendingRelayRequests.set(id, { resolve, reject, timer })
      this.enqueueFrame(client, msg, 'control')
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
    // Why: can't send responses after dispose; abort in-flight work so SSH-side scans/watchers release.
    this.requestAborts.abortAll()
    for (const client of this.clients.values()) {
      client.closed = true
      client.writer.close(new Error('Relay dispatcher disposed'))
    }
    for (const listener of Array.from(this.legacyCapacityListeners)) {
      listener()
    }
    this.legacyCapacityListeners.clear()
    for (const listener of Array.from(this.disposeListeners)) {
      listener()
    }
    this.disposeListeners.clear()
  }

  private createClient(
    write: RelayClientWrite,
    sinkOptions?: RelayClientSinkOptions,
    sessionIdentity?: RelayClientSessionIdentity,
    sourceOptions?: RelayClientSourceOptions
  ): RelayClient {
    const id = this.nextClientId++
    const client = {
      id,
      decoder: undefined as unknown as FrameDecoder,
      writer: undefined as unknown as DispatcherClientWriter,
      bulkChain: Promise.resolve(),
      nextOutgoingSeq: 1,
      highestReceivedSeq: 0,
      generation: 0,
      closed: false,
      sessionIdentity: sessionIdentity ?? {
        principal: `unproved:${id}`,
        authenticated: false,
        allowSessionOwner: false,
        authenticationKind: 'unproved'
      }
    } satisfies RelayClient
    client.decoder = new FrameDecoder(
      (frame) => this.handleFrame(client, frame),
      (error) => this.closeClient(client, error, client !== this.primaryClient),
      { pause: sourceOptions?.pauseReads, resume: sourceOptions?.resumeReads }
    )
    client.writer = this.createWriter(client, write, sinkOptions)
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

    // Why: snapshot generation before the await to detect if the client disconnected mid-flight.
    const gen = client.generation
    const { key: abortKey, controller: abortController } = this.requestAborts.create(
      client.id,
      req.id
    )
    const responseSettledHandlers = new Set<(result: SinkWriteSettlement) => void>()
    let responseSettled = false
    const settleResponse = (result: SinkWriteSettlement): void => {
      if (responseSettled) {
        return
      }
      responseSettled = true
      for (const callback of responseSettledHandlers) {
        try {
          callback(result)
        } catch (err) {
          process.stderr.write(
            `[relay] Response settlement callback failed: ${err instanceof Error ? err.message : String(err)}\n`
          )
        }
      }
      responseSettledHandlers.clear()
      this.requestAborts.delete(abortKey)
    }
    const context: RequestContext = {
      clientId: client.id,
      isStale: () =>
        client.generation !== gen || !this.clients.has(client.id) || abortController.signal.aborted,
      signal: abortController.signal,
      sessionIdentity: client.sessionIdentity,
      onResponseSettled: (handler) => {
        if (responseSettled) {
          throw new Error('Response settlement callback registered after settlement')
        }
        responseSettledHandlers.add(handler)
      }
    }
    try {
      const result = await handler(req.params ?? {}, context)
      if (context.isStale()) {
        settleResponse({ ok: false, error: new Error('Relay request became stale') })
        return
      }
      const accepted = this.sendResponse(client, req.id, result, undefined, (settlement) => {
        settleResponse(
          context.isStale()
            ? { ok: false, error: new Error('Relay request became stale') }
            : settlement
        )
      })
      if (!accepted) {
        settleResponse({ ok: false, error: new Error('Relay response was not admitted') })
      }
    } catch (err) {
      if (context.isStale()) {
        settleResponse({ ok: false, error: new Error('Relay request became stale') })
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      const code = (err as { code?: number }).code ?? -32000
      const accepted = this.sendResponse(client, req.id, undefined, { code, message }, (result) => {
        settleResponse({
          ok: false,
          error: result.ok ? new Error(message) : result.error
        })
      })
      if (!accepted) {
        settleResponse({ ok: false, error: new Error('Relay error response was not admitted') })
      }
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
        isStale: () => client.generation !== gen || !this.clients.has(client.id),
        sessionIdentity: client.sessionIdentity,
        onResponseSettled: () => {
          throw new Error('Notifications do not have response publication fences')
        }
      })
    }
  }

  private sendResponse(
    client: RelayClient,
    id: number,
    result?: unknown,
    error?: { code: number; message: string; data?: unknown },
    onSettled: (result: SinkWriteSettlement) => void = () => {}
  ): boolean {
    const msg: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      ...(error ? { error } : { result: result ?? null })
    }
    const estimatedBytes = this.estimateFrameBytes(msg)
    const lane = estimatedBytes > DISPATCHER_CONTROL_QUEUE_MAX_BYTES ? 'legacy-response' : 'control'
    const accepted = this.enqueueFrame(client, msg, lane, onSettled)
    if (!accepted) {
      this.closeClient(
        client,
        new Error(
          `Relay response exceeds the bounded ${DEFAULT_PRODUCER_QUEUE_MAX_BYTES}-byte legacy lane`
        ),
        client !== this.primaryClient
      )
    }
    return accepted
  }

  private enqueueFrame(
    client: RelayClient,
    msg: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification,
    lane: DispatcherWriterLane,
    onSettled: (result: SinkWriteSettlement) => void = () => {}
  ): boolean {
    if (this.disposed || client.closed) {
      return false
    }
    const estimatedBytes = this.estimateFrameBytes(msg)
    return client.writer.enqueue(
      lane,
      () => {
        const seq = client.nextOutgoingSeq++
        return encodeJsonRpcFrame(msg, seq, client.highestReceivedSeq)
      },
      estimatedBytes,
      onSettled
    )
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
        client.writer.enqueue(
          'liveness',
          () => {
            const seq = client.nextOutgoingSeq++
            return encodeKeepAliveFrame(seq, client.highestReceivedSeq)
          },
          13
        )
      }
    }, KEEPALIVE_SEND_MS)
    // Why: unref so the keepalive interval doesn't pin the event loop and block process exit.
    this.keepaliveTimer.unref()
  }

  private activeClients(): RelayClient[] {
    return Array.from(this.clients.values()).filter((client) => !client.closed)
  }

  private activeClientKeys(): string[] {
    return this.activeClients().map((client) => this.clientKey(client))
  }

  private clientKey(client: RelayClient): string {
    return `${client.id}:${client.generation}`
  }

  private estimateFrameBytes(msg: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification): number {
    return encodeJsonRpcFrame(msg, 0, 0).length
  }

  private tryPublishToClients(
    clients: readonly RelayClient[],
    msg: JsonRpcNotification,
    lane: 'interactive' | 'ordinary' | 'bulk'
  ): boolean {
    return this.runPublicationTransaction(() => {
      if (clients.length === 0) {
        return true
      }
      const bytes = this.estimateFrameBytes(msg)
      if (clients.some((client) => !client.writer.canEnqueueProducer(bytes))) {
        return false
      }
      const leases = this.publicationLedger.tryReserve(
        clients.map((client) => ({ clientKey: this.clientKey(client), bytes }))
      )
      if (!leases) {
        return false
      }
      for (let index = 0; index < clients.length; index++) {
        if (!this.enqueueLeasedFrame(clients[index], msg, lane, leases[index])) {
          if (this.disposed || clients[index].closed) {
            continue
          }
          for (let remaining = index; remaining < leases.length; remaining++) {
            leases[remaining].release()
          }
          return false
        }
      }
      return true
    })
  }

  private projectToClients(
    clients: readonly RelayClient[],
    msg: JsonRpcNotification,
    lane: 'interactive' | 'ordinary'
  ): boolean {
    return this.runPublicationTransaction(() => {
      for (const client of clients) {
        if (client.closed || this.publishToClient(client, msg, lane)) {
          continue
        }
        this.closeClient(
          client,
          new Error('Relay PTY subscriber projection capacity exceeded'),
          client !== this.primaryClient
        )
      }
      return !this.disposed
    })
  }

  private publishToClient(
    client: RelayClient,
    msg: JsonRpcNotification,
    lane: 'interactive' | 'ordinary' | 'fixed-bulk' | 'bulk',
    onSettled: (result: SinkWriteSettlement) => void = () => {}
  ): boolean {
    const bytes = this.estimateFrameBytes(msg)
    const fixedBlocked =
      lane === 'fixed-bulk' &&
      (client.writer.retainedProducerBytes > 0 || bytes > client.writer.fixedFrameCapacity)
    if (fixedBlocked || (lane !== 'fixed-bulk' && !client.writer.canEnqueueProducer(bytes))) {
      return false
    }
    const leases = this.publicationLedger.tryReserve([{ clientKey: this.clientKey(client), bytes }])
    if (!leases) {
      return false
    }
    return this.enqueueLeasedFrame(client, msg, lane, leases[0], onSettled)
  }

  private publishBulkWhenAvailable(client: RelayClient, msg: JsonRpcNotification): Promise<void> {
    const bytes = this.estimateFrameBytes(msg)
    const lane = msg.method === 'fs.streamChunk' ? 'fixed-bulk' : 'bulk'
    if (bytes > DEFAULT_PRODUCER_QUEUE_MAX_BYTES) {
      return Promise.reject(new Error('Relay bulk frame exceeds sink producer capacity'))
    }
    if (lane === 'bulk' && bytes > client.writer.producerFrameCapacity) {
      return Promise.reject(new Error('Relay bulk frame exceeds sink frame capacity'))
    }
    return new Promise<void>((resolve, reject) => {
      let removeCapacityListener: (() => void) | null = null
      const finish = (): void => {
        removeCapacityListener?.()
        removeCapacityListener = null
      }
      const tryPublish = (): void => {
        if (this.disposed || client.closed) {
          finish()
          resolve()
          return
        }
        if (
          this.publishToClient(client, msg, lane, (result) => {
            finish()
            if (result.ok || this.disposed || client.closed) {
              resolve()
            } else {
              reject(result.error)
            }
          })
        ) {
          return
        }
        if (!removeCapacityListener) {
          removeCapacityListener = this.onLegacyPtyCapacity(tryPublish)
        }
      }
      tryPublish()
    })
  }

  private enqueueLeasedFrame(
    client: RelayClient,
    msg: JsonRpcNotification,
    lane: 'interactive' | 'ordinary' | 'fixed-bulk' | 'bulk',
    lease: LegacyPublicationLease,
    onSettled: (result: SinkWriteSettlement) => void = () => {}
  ): boolean {
    const accepted = this.enqueueFrame(client, msg, lane, (result) => {
      lease.release()
      onSettled(result)
      this.notifyLegacyCapacityIfLow()
    })
    if (!accepted) {
      lease.release()
      this.notifyLegacyCapacityIfLow()
    }
    return accepted
  }

  private createWriter(
    client: RelayClient,
    write: RelayClientWrite,
    sinkOptions?: RelayClientSinkOptions
  ): DispatcherClientWriter {
    const writer = new DispatcherClientWriter(write, sinkOptions, (error) => {
      this.closeClient(client, error, client !== this.primaryClient)
    })
    writer.onCapacity(() => this.notifyLegacyCapacityIfLow())
    return writer
  }

  private closeClient(client: RelayClient, error: Error, remove: boolean): void {
    if (client.closed) {
      return
    }
    client.closed = true
    this.requestAborts.abortClient(client.id)
    client.writer.close(error)
    client.generation++
    if (remove) {
      this.clients.delete(client.id)
    }
    this.notifyClientDetached(client.id)
    this.notifyLegacyCapacity(true)
    if (!/^Relay (?:primary client invalidated|client detached)$/.test(error.message)) {
      process.stderr.write(`[relay] Client write closed: ${error.message}\n`)
    }
  }

  private notifyLegacyCapacityIfLow(): void {
    this.notifyLegacyCapacity(false)
  }

  private notifyLegacyCapacity(force: boolean): void {
    if (this.publicationTransactionDepth > 0) {
      this.deferredForcedLegacyCapacity ||= force
      this.deferredLegacyCapacity ||= !force
      return
    }
    if (!force && !this.publicationLedger.belowLowWater(this.activeClientKeys())) {
      return
    }
    for (const listener of this.legacyCapacityListeners) {
      listener()
    }
  }

  private runPublicationTransaction<T>(operation: () => T): T {
    this.publicationTransactionDepth++
    try {
      return operation()
    } finally {
      this.publicationTransactionDepth--
      if (this.publicationTransactionDepth === 0) {
        const force = this.deferredForcedLegacyCapacity
        const low = this.deferredLegacyCapacity
        this.deferredForcedLegacyCapacity = false
        this.deferredLegacyCapacity = false
        if (force || low) {
          this.notifyLegacyCapacity(force)
        }
      }
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
