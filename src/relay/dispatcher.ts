/* eslint-disable max-lines -- dispatcher keeps client routing, cancellation, and framing state together */
import {
  FrameDecoder,
  HEADER_LENGTH,
  MessageType,
  encodePreparedJsonRpcFrame,
  encodeKeepAliveFrame,
  parseJsonRpcMessage,
  prepareJsonRpcPayload,
  KEEPALIVE_SEND_MS,
  RelayErrorCode,
  type DecodedFrame,
  type JsonRpcRequest,
  type JsonRpcNotification,
  type JsonRpcResponse,
  type PreparedJsonRpcPayload
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
import type { PtyConsumerCloseCause } from '../shared/pty-consumer-session-contract'
import {
  SKILL_INSTALL_RPC_ERROR_CODE,
  SkillInstallFailureSchema
} from '../shared/skill-install-failure'

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

export type PtyDataPublicationAdmission = (
  clientId: number,
  params: Readonly<Record<string, unknown>>
) => boolean

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
  droppedNotificationLog: DroppedProducerNotificationLog | null
  sessionIdentity: RelayClientSessionIdentity
}

type OutgoingJsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

type PreparedRelayFrame = Readonly<{
  payload: PreparedJsonRpcPayload
  frameBytes: number
  ptyDataAdmissionParams: Readonly<Record<string, unknown>> | null
}>

// Why: the log key set is rebuilt per generation, but a producer minting synthetic method names would still
// grow it inside one generation — cap it well above the fixed relay method vocabulary.
const DROPPED_NOTIFICATION_LOG_KEY_LIMIT = 64

const RESPONSE_OVER_CAPACITY_MESSAGE = 'Relay response exceeded the bounded transport capacity'

type DroppedProducerNotificationLog = {
  generation: number
  loggedKeys: Set<string>
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
  private clientDetachListeners = new Set<
    (clientId: number, cause: PtyConsumerCloseCause) => void
  >()
  private disposeListeners = new Set<() => void>()
  private legacyCapacityListeners = new Set<() => void>()
  private clientCapacityListeners = new Map<number, Set<() => void>>()
  private ptyDataPublicationAdmission: PtyDataPublicationAdmission | null = null
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
  // Why: a new multiplexer restarts at seq=1; reset state to avoid stalled acknowledgements.
  setWrite(write: RelayClientWrite, sinkOptions?: RelayClientSinkOptions): void {
    this.requestAborts.abortClient(this.primaryClient.id)
    this.primaryClient.closed = true
    this.primaryClient.writer.close(new Error('Relay primary sink replaced'))
    this.resetClient(this.primaryClient)
    this.primaryClient.writer = this.createWriter(this.primaryClient, write, sinkOptions)
    // Why: a frame retained against the replaced sink would otherwise wait for traffic that may never come.
    this.notifyClientCapacity(this.primaryClient.id)
  }

  // Why: mark in-flight requests stale on disconnect so a late pty.spawn/fs.watch can't create unowned remote state.
  invalidateClient(cause: PtyConsumerCloseCause = 'local'): void {
    this.closeClient(
      this.primaryClient,
      new Error('Relay primary client invalidated'),
      false,
      cause
    )
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

  detachClient(clientId: number, cause: PtyConsumerCloseCause = 'local'): void {
    const client = this.clients.get(clientId)
    if (!client || client === this.primaryClient) {
      return
    }
    this.closeClient(client, new Error('Relay client detached'), true, cause)
  }

  // Why: a displaced owner must lose its transport whichever client holds it, and the launch channel is
  // often the half-open one. The primary keeps its id for setWrite() revival, so invalidate it instead.
  releaseDisplacedClient(clientId: number): void {
    if (clientId === this.primaryClient.id) {
      this.invalidateClient()
      return
    }
    this.detachClient(clientId)
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

  // Why it throws: this is a single slot, so a second registration silently shadows the
  // first and which one survives depends only on construction order. `pty.ackData` shipped
  // that way — a no-op handler was saved from disabling credit acks purely by the adapter
  // being constructed second (STA-4571). Fail loudly instead of encoding that ordering.
  onNotification(method: string, handler: NotificationHandler): void {
    if (this.notificationHandlers.has(method)) {
      throw new Error(`Notification handler for ${method} is already registered`)
    }
    this.notificationHandlers.set(method, handler)
  }

  onClientDetached(listener: (clientId: number, cause: PtyConsumerCloseCause) => void): () => void {
    this.clientDetachListeners.add(listener)
    return () => this.clientDetachListeners.delete(listener)
  }

  onDisposed(listener: () => void): () => void {
    this.disposeListeners.add(listener)
    return () => this.disposeListeners.delete(listener)
  }

  // Why single-slot rather than a listener set: admission is a veto, so two registrations would have
  // to agree on precedence. One owner (the PTY consumer session) holds it for the dispatcher's life.
  registerPtyDataPublicationAdmission(admission: PtyDataPublicationAdmission): () => void {
    if (this.ptyDataPublicationAdmission) {
      throw new Error('PTY data publication admission is already registered')
    }
    this.ptyDataPublicationAdmission = admission
    return () => {
      if (this.ptyDataPublicationAdmission === admission) {
        this.ptyDataPublicationAdmission = null
      }
    }
  }

  onLegacyPtyCapacity(listener: () => void): () => void {
    this.legacyCapacityListeners.add(listener)
    return () => this.legacyCapacityListeners.delete(listener)
  }

  /**
   * Ungated per-client writer capacity, for a frame that lost control-lane admission and must retry.
   * onLegacyPtyCapacity cannot serve that: it is gated on producer retention, so it stays silent
   * exactly under the dual-queue pressure that rejected the frame. Registered on the dispatcher, not
   * the writer, so a retry survives setWrite() replacing the primary sink.
   * Returns null only when the client is gone for good. A merely closed client still counts: setWrite
   * marks the primary closed before replacing its sink, and that replacement is exactly when a frame
   * stranded by the old writer must be armed to retry.
   */
  onClientCapacity(clientId: number, listener: () => void): (() => void) | null {
    const client = this.clients.get(clientId)
    if (this.disposed || !client) {
      return null
    }
    const listeners = this.clientCapacityListeners.get(clientId) ?? new Set<() => void>()
    listeners.add(listener)
    this.clientCapacityListeners.set(clientId, listeners)
    return () => {
      const current = this.clientCapacityListeners.get(clientId)
      if (!current?.delete(listener) || current.size > 0) {
        return
      }
      this.clientCapacityListeners.delete(clientId)
    }
  }

  /**
   * Whether the id still names a client. A detach notification does not always mean it stopped:
   * invalidateClient() detaches the primary without removing it, and setWrite() revives that same id.
   */
  isClientAttached(clientId: number): boolean {
    return !this.disposed && this.clients.has(clientId)
  }

  canAdmitControlFrame(clientId: number, estimatedBytes: number): boolean {
    const client = this.clients.get(clientId)
    if (this.disposed || !client || client.closed) {
      return false
    }
    return client.writer.canEnqueueControl(estimatedBytes)
  }

  get legacyRetentionBelowLowWater(): boolean {
    return this.publicationLedger.belowLowWater(this.activeClientKeys())
  }

  /**
   * Same reserve as legacyRetentionBelowLowWater, but scoped to one client: a paced bulk producer
   * gated on the dispatcher-wide signal stops for a peer's stall and degrades a healthy link.
   * The relay-wide aggregate still counts — that ceiling is shared by every client.
   */
  producerRetentionBelowLowWater(clientId: number): boolean {
    const client = this.clients.get(clientId)
    if (!client || client.closed) {
      return false
    }
    return this.publicationLedger.belowLowWater([this.clientKey(client)])
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
    const clients = this.activeClients().filter((client) =>
      this.admitsPtyDataPublication(client.id, params)
    )
    const max = Math.min(data.length, limit)
    if (clients.length === 0) {
      return max
    }
    if (!(max > 0)) {
      return 0
    }
    const fitsAll = (bytes: number): boolean =>
      clients.every((client) => bytes <= client.writer.producerFrameCapacity)
    const sizeFrame = (chunk: string): number =>
      this.estimateFrameBytes({
        jsonrpc: '2.0',
        method: 'pty.data',
        params: { ...params, data: chunk }
      })
    // Fast path: the whole chunk usually fits — one encode instead of log2(n).
    if (fitsAll(sizeFrame(data.slice(0, max)))) {
      return max
    }
    // Exact per-step size: only the escaped data string varies; its quotes are in baseBytes.
    const baseBytes = sizeFrame('')
    const bytesFor = (chars: number): number =>
      baseBytes + Buffer.byteLength(JSON.stringify(data.slice(0, chars))) - 2
    let low = 0
    let high = max
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (fitsAll(bytesFor(mid))) {
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
      this.activeClients().filter((client) => this.admitsPtyDataPublication(client.id, params)),
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
      this.activeClients().filter(
        (client) => matchesClient(client.id) && this.admitsPtyDataPublication(client.id, params)
      ),
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
      this.activeClients().filter(
        (client) => matchesClient(client.id) && this.admitsPtyDataPublication(client.id, params)
      ),
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
    if (!this.admitsPtyDataPublication(clientId, params)) {
      onSettled({ ok: false, error: new Error('PTY publication is not admitted') })
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

  activeClientIds(): number[] {
    return this.activeClients().map((client) => client.id)
  }

  // Why: signed on purpose — `budget >= 0` is an exact fits-check that a floored budget cannot express.
  producerEnvelopeBudget(
    method: string,
    params: Record<string, unknown>,
    clientId?: number
  ): number {
    if (clientId !== undefined) {
      const client = this.clients.get(clientId)
      // Why: a detached or closed target has no room at all — reporting infinite capacity passes a
      // fits-check and the frame is then dropped by the publish seam instead.
      if (!client || client.closed) {
        return Number.MIN_SAFE_INTEGER
      }
      return (
        client.writer.producerFrameCapacity -
        this.estimateFrameBytes({ jsonrpc: '2.0', method, params })
      )
    }
    const targets = this.activeClients()
    if (targets.length === 0) {
      return Number.MAX_SAFE_INTEGER
    }
    const frameBytes = this.estimateFrameBytes({ jsonrpc: '2.0', method, params })
    return Math.min(...targets.map((client) => client.writer.producerFrameCapacity - frameBytes))
  }

  producerDataBudget(
    method: string,
    paramsWithoutData: Record<string, unknown>,
    clientId?: number
  ): number {
    return Math.max(
      0,
      this.producerEnvelopeBudget(method, { ...paramsWithoutData, data: '' }, clientId)
    )
  }

  // notify() broadcasts one frame, so chunks must fit the smallest attached capacity.
  broadcastProducerFrameCapacity(): number | undefined {
    if (this.disposed) {
      return undefined
    }
    const clients = this.activeClients()
    if (clients.length === 0) {
      return undefined
    }
    return Math.min(...clients.map((client) => client.writer.producerFrameCapacity))
  }

  notificationFrameBytes(method: string, params?: Record<string, unknown>): number {
    return this.estimateFrameBytes({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {})
    })
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
      let frame: PreparedRelayFrame | undefined
      for (const client of this.clients.values()) {
        if (client.closed) {
          continue
        }
        if (method === 'pty.data' && !this.admitsPtyDataPublication(client.id, params ?? {})) {
          continue
        }
        frame ??= this.prepareFrame(msg)
        if (method === 'pty.replay') {
          // Why: replay is never re-sent, so it takes the control lane where overflow is fatal — the
          // writer closes the client and reconnect reloads history rather than stranding a short buffer.
          this.enqueuePreparedFrame(client, frame, 'control')
          continue
        }
        // Why: closing can never make an oversized frame sendable — the producer regenerates it after
        // reattach and re-kills the link, turning a recoverable drop into an endless reconnect loop.
        if (!this.publishPreparedToClient(client, frame, 'ordinary')) {
          this.logDroppedProducerNotification(client, method, frame.frameBytes)
        }
      }
    })
  }

  // Why: producer-lane publication for a single client; notifyClient/tryNotifyClient use the control lane,
  // which floods must never occupy. Rejection drops the frame and never closes the client.
  publishProducerNotification(
    clientId: number,
    method: string,
    params?: Record<string, unknown>,
    // Why: a caller that recovers from rejection itself (the watcher emitter re-sends the batch in
    // chunks) would otherwise log "Dropped" for a frame it goes on to deliver in full.
    options?: { logDrop?: boolean }
  ): boolean {
    if (this.disposed) {
      return false
    }
    const client = this.clients.get(clientId)
    if (!client || client.closed) {
      return false
    }
    const msg: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {})
    }
    if (method === 'pty.data' && !this.admitsPtyDataPublication(client.id, params ?? {})) {
      return false
    }
    const frame = this.prepareFrame(msg)
    if (this.publishPreparedToClient(client, frame, 'ordinary')) {
      return true
    }
    // Why: same diagnostics as notify() — a producer that drops here must not do so silently.
    if (options?.logDrop !== false) {
      this.logDroppedProducerNotification(client, method, frame.frameBytes)
    }
    return false
  }

  // Why: one line per generation, method and drop reason — a flooding producer retries every batch and would
  // spam stderr, but a transient queue-full drop must not consume the slot a real over-capacity drop needs.
  private logDroppedProducerNotification(client: RelayClient, method: string, bytes: number): void {
    const capacity = client.writer.producerFrameCapacity
    const overCapacity = bytes > capacity
    const key = `${method}:${overCapacity ? 'over-capacity' : 'queue-full'}`
    let log = client.droppedNotificationLog
    if (!log || log.generation !== client.generation) {
      log = { generation: client.generation, loggedKeys: new Set() }
      client.droppedNotificationLog = log
    }
    if (log.loggedKeys.has(key) || log.loggedKeys.size >= DROPPED_NOTIFICATION_LOG_KEY_LIMIT) {
      return
    }
    log.loggedKeys.add(key)
    process.stderr.write(
      overCapacity
        ? `[relay] Dropped ${method} (${bytes}B > producer frame capacity ${capacity}B)\n`
        : `[relay] Dropped ${method} (${bytes}B, producer queue full; frame capacity ${capacity}B)\n`
    )
  }

  notifyClient(clientId: number, method: string, params?: Record<string, unknown>): void {
    this.tryNotifyClient(clientId, method, params)
  }

  tryNotifyClient(
    clientId: number,
    method: string,
    params?: Record<string, unknown>,
    onSettled: (result: SinkWriteSettlement) => void = () => {},
    options: {
      controlOverflow?: 'close-client' | 'reject'
    } = {}
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
      onSettled,
      options.controlOverflow
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
    const clients = this.activeClients()
    if (clients.length === 0) {
      return
    }
    const frame = this.prepareFrame(msg)
    for (const client of clients) {
      if (!this.enqueuePreparedFrame(client, frame, 'control')) {
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
    const targets =
      opts?.clientId !== undefined
        ? [this.clients.get(opts.clientId)].filter((c): c is RelayClient => c !== undefined)
        : Array.from(this.clients.values())
    const activeTargets = targets.filter((client) => !client.closed)
    if (activeTargets.length === 0) {
      return Promise.resolve()
    }
    const msg: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params: { ...params } } : {})
    }
    let prepared:
      | { ok: true; frame: PreparedRelayFrame }
      | { ok: false; error: unknown }
      | undefined
    const prepareOnce = (): PreparedRelayFrame => {
      if (!prepared) {
        try {
          prepared = { ok: true, frame: this.prepareFrame(msg) }
        } catch (error) {
          prepared = { ok: false, error }
        }
      }
      if (!prepared.ok) {
        throw prepared.error
      }
      return prepared.frame
    }
    const lane = method === 'fs.streamChunk' ? 'fixed-bulk' : 'bulk'
    const waits: Promise<void>[] = []
    for (const client of activeTargets) {
      const step = client.bulkChain.then(() => {
        if (this.disposed || client.closed) {
          return
        }
        return this.publishBulkWhenAvailable(client, prepareOnce(), lane)
      })
      client.bulkChain = step.catch(() => {})
      waits.push(step)
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
      if (!this.enqueueFrame(client, msg, 'control', () => {}, 'reject')) {
        clearTimeout(timer)
        this.pendingRelayRequests.delete(id)
        reject(new Error(`Request "${method}" exceeded the relay control transport capacity`))
      }
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
    this.clientCapacityListeners.clear()
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
      droppedNotificationLog: null,
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
      const errorCode = (err as { code?: unknown }).code
      const code = typeof errorCode === 'number' ? errorCode : -32000
      const skillFailure =
        errorCode === SKILL_INSTALL_RPC_ERROR_CODE
          ? SkillInstallFailureSchema.safeParse((err as { data?: unknown }).data)
          : null
      const data = skillFailure?.success === true ? skillFailure.data : undefined
      const accepted = this.sendResponse(
        client,
        req.id,
        undefined,
        { code, message, ...(data === undefined ? {} : { data }) },
        (result) => {
          settleResponse({
            ok: false,
            error: result.ok ? new Error(message) : result.error
          })
        }
      )
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
    const frame = this.prepareFrame(msg)
    const lane =
      frame.frameBytes > DISPATCHER_CONTROL_QUEUE_MAX_BYTES ? 'legacy-response' : 'control'
    const accepted = this.enqueuePreparedFrame(client, frame, lane, onSettled)
    if (accepted) {
      return true
    }
    // Why: an oversized response must fail its own request; closing would kill every pane on the host.
    // A rejected first enqueue either left onSettled untouched or closed the client, so exactly one settlement happens.
    return this.enqueuePreparedFrame(
      client,
      this.prepareFrame({
        jsonrpc: '2.0',
        id,
        error: {
          code: RelayErrorCode.ResponseOverCapacity,
          message: RESPONSE_OVER_CAPACITY_MESSAGE
        }
      }),
      'control',
      // Why: writing the substitute is not delivering the result — a settlement fence must never read
      // the capacity error's successful write as "the peer received your result".
      (settlement) =>
        onSettled(
          settlement.ok
            ? { ok: false, error: new Error(RESPONSE_OVER_CAPACITY_MESSAGE) }
            : settlement
        )
    )
  }

  private enqueueFrame(
    client: RelayClient,
    msg: OutgoingJsonRpcMessage,
    lane: DispatcherWriterLane,
    onSettled: (result: SinkWriteSettlement) => void = () => {},
    controlOverflow: 'close-client' | 'reject' = 'close-client'
  ): boolean {
    if (this.disposed || client.closed) {
      return false
    }
    return this.enqueuePreparedFrame(
      client,
      this.prepareFrame(msg),
      lane,
      onSettled,
      controlOverflow
    )
  }

  private enqueuePreparedFrame(
    client: RelayClient,
    frame: PreparedRelayFrame,
    lane: DispatcherWriterLane,
    onSettled: (result: SinkWriteSettlement) => void = () => {},
    controlOverflow: 'close-client' | 'reject' = 'close-client'
  ): boolean {
    if (this.disposed || client.closed) {
      return false
    }
    const encode = (): Buffer => {
      const seq = client.nextOutgoingSeq++
      return encodePreparedJsonRpcFrame(frame.payload, seq, client.highestReceivedSeq)
    }
    const admissionParams = frame.ptyDataAdmissionParams
    const isStillAdmitted = admissionParams
      ? () => this.admitsPtyDataPublication(client.id, admissionParams)
      : undefined
    return client.writer.enqueue(
      lane,
      encode,
      frame.frameBytes,
      onSettled,
      lane === 'control' && controlOverflow === 'reject',
      isStillAdmitted
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

  private admitsPtyDataPublication(
    clientId: number,
    params: Readonly<Record<string, unknown>>
  ): boolean {
    return this.ptyDataPublicationAdmission?.(clientId, params) ?? true
  }

  private activeClientKeys(): string[] {
    return this.activeClients().map((client) => this.clientKey(client))
  }

  private clientKey(client: RelayClient): string {
    return `${client.id}:${client.generation}`
  }

  private prepareFrame(msg: OutgoingJsonRpcMessage): PreparedRelayFrame {
    const payload = prepareJsonRpcPayload(msg)
    const params = 'method' in msg && msg.method === 'pty.data' ? (msg.params ?? {}) : null
    return Object.freeze({
      payload,
      frameBytes: HEADER_LENGTH + payload.byteLength,
      ptyDataAdmissionParams:
        params === null
          ? null
          : Object.freeze({
              id: params.id,
              deliveryToken: params.deliveryToken,
              clientGeneration: params.clientGeneration,
              ownerGeneration: params.ownerGeneration,
              ptyIncarnation: params.ptyIncarnation
            })
    })
  }

  private estimateFrameBytes(msg: OutgoingJsonRpcMessage): number {
    return HEADER_LENGTH + prepareJsonRpcPayload(msg).byteLength
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
      const frame = this.prepareFrame(msg)
      const bytes = frame.frameBytes
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
        if (!this.enqueueLeasedFrame(clients[index], frame, lane, leases[index])) {
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
      if (clients.length === 0) {
        return true
      }
      const frame = this.prepareFrame(msg)
      for (const client of clients) {
        if (client.closed || this.publishPreparedToClient(client, frame, lane)) {
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
    if (this.disposed || client.closed) {
      return false
    }
    return this.publishPreparedToClient(client, this.prepareFrame(msg), lane, onSettled)
  }

  private publishPreparedToClient(
    client: RelayClient,
    frame: PreparedRelayFrame,
    lane: 'interactive' | 'ordinary' | 'fixed-bulk' | 'bulk',
    onSettled: (result: SinkWriteSettlement) => void = () => {}
  ): boolean {
    const bytes = frame.frameBytes
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
    return this.enqueueLeasedFrame(client, frame, lane, leases[0], onSettled)
  }

  private publishBulkWhenAvailable(
    client: RelayClient,
    frame: PreparedRelayFrame,
    lane: 'fixed-bulk' | 'bulk'
  ): Promise<void> {
    const bytes = frame.frameBytes
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
          this.publishPreparedToClient(client, frame, lane, (result) => {
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
    frame: PreparedRelayFrame,
    lane: 'interactive' | 'ordinary' | 'fixed-bulk' | 'bulk',
    lease: LegacyPublicationLease,
    onSettled: (result: SinkWriteSettlement) => void = () => {}
  ): boolean {
    const accepted = this.enqueuePreparedFrame(client, frame, lane, (result) => {
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
    writer.onCapacity(() => {
      this.notifyLegacyCapacityIfLow()
      this.notifyClientCapacity(client.id)
    })
    return writer
  }

  private notifyClientCapacity(clientId: number): void {
    const listeners = this.clientCapacityListeners.get(clientId)
    if (!listeners?.size) {
      return
    }
    for (const listener of Array.from(listeners)) {
      try {
        listener()
      } catch (err) {
        process.stderr.write(
          `[relay] Client capacity listener failed: ${err instanceof Error ? err.message : String(err)}\n`
        )
      }
    }
  }

  private closeClient(
    client: RelayClient,
    error: Error,
    remove: boolean,
    // Why the default is the cautious one: most closes here are the relay's own doing, and only the
    // callers holding real evidence of a peer-side transport end may say so.
    cause: PtyConsumerCloseCause = 'local'
  ): void {
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
    this.notifyClientDetached(client.id, cause)
    if (remove) {
      // Only for a client that is gone for good: an invalidated primary is revived by setWrite, and a
      // frame stranded by its retired sink must stay armed to retry. After the detach fan-out, so a
      // listener that unsubscribes on detach is not left holding a stale slot.
      this.clientCapacityListeners.delete(client.id)
    }
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

  private notifyClientDetached(clientId: number, cause: PtyConsumerCloseCause): void {
    for (const listener of this.clientDetachListeners) {
      try {
        listener(clientId, cause)
      } catch (err) {
        process.stderr.write(
          `[relay] Client detach listener failed: ${err instanceof Error ? err.message : String(err)}\n`
        )
      }
    }
  }
}
