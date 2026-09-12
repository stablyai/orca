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
import {
  SshMultiplexerTransportWriter,
  type MultiplexerTransport,
  type MultiplexerWriteSettlement,
  type MultiplexerWriterLane
} from './ssh-multiplexer-transport-writer'

export type { MultiplexerTransport, MultiplexerWriteSettlement }
import { SshMultiplexerSettlementBarrier } from './ssh-multiplexer-settlement-barrier'
import {
  RELAY_OWNER_RESET_METHOD,
  RELAY_PREPARED_RESET_RECOVERY_METHOD,
  parseRelayOwnerResetRequest,
  parseRelayOwnerResetAcknowledgment,
  type RelayOwnerResetRequest,
  type RelayOwnerResetAcknowledgment
} from '../../shared/relay-owner-reset-contract'
import { SshPtyPreparationAdmission } from './ssh-pty-preparation-admission'
import { SshMultiplexerIncomingRequests } from './ssh-multiplexer-incoming-requests'
import { RELAY_NETWORK_TUNNEL_FRAME_METHOD } from '../../shared/relay-network-tunnel-contract'

type PendingRequest = {
  resetRequest?: RelayOwnerResetRequest
  method: string
  token: object
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  beforeResolve?: (result: unknown) => void
  timer: ReturnType<typeof setTimeout>
  cleanup: () => void
}

export type SshMultiplexerRequestOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  beforeResolve?: (result: unknown) => void
}

export type NotificationHandler = (method: string, params: Record<string, unknown>) => void
export type MethodNotificationHandler = (params: Record<string, unknown>) => void
export type RequestHandler = (params: Record<string, unknown>) => unknown

export type MultiplexerDisposeReason = 'shutdown' | 'connection_lost'

// Why: the renderer uses the message/code to distinguish temporary disconnects
// (show reconnection overlay) from permanent shutdown (show error toast), so
// every producer of a disposal rejection must mint it here — a divergent copy
// silently downgrades the relay-lost UI to a bug-report toast.
export function createSshDisposalError(reason: MultiplexerDisposeReason): Error & { code: string } {
  const lost = reason === 'connection_lost'
  const err = new Error(
    lost ? 'SSH connection lost, reconnecting...' : 'Multiplexer disposed'
  ) as Error & { code: string }
  err.code = lost ? 'CONNECTION_LOST' : 'DISPOSED'
  return err
}

const REQUEST_TIMEOUT_MS = 30_000
const MAX_ORDINARY_UNACKED_TIMESTAMPS = 4095
const MAX_UNACKED_TIMESTAMPS = MAX_ORDINARY_UNACKED_TIMESTAMPS + 1
// Why: a tick gap far beyond the interval means the process was paused
// (system sleep, App Nap timer throttling) — not that the link is dead (#7773).
const WAKE_GAP_MS = KEEPALIVE_SEND_MS * 3

// Why: callers branch on "the request timed out" (fall back to a slower path,
// report a host issue). Matching the message text made every unrelated error
// carrying the same phrase take the timeout branch.
export const SSH_MUX_REQUEST_TIMEOUT_CODE = 'SSH_MUX_REQUEST_TIMEOUT'

function sshMuxRequestTimeoutError(method: string, timeoutMs: number): Error {
  return Object.assign(new Error(`Request "${method}" timed out after ${timeoutMs}ms`), {
    code: SSH_MUX_REQUEST_TIMEOUT_CODE
  })
}

/**
 * True when a request may have run on the host despite failing here.
 *
 * A response deadline and a link declared lost are the same verdict: the frame reached the wire and
 * the peer's answer did not come back, so the work is `unverifiable`, never absent. Declaring a
 * wedged link lost at TIMEOUT_MS turned what used to surface as SSH_MUX_REQUEST_TIMEOUT into
 * CONNECTION_LOST, so callers that phrase the verdict to a user must branch on this rather than on
 * the timeout alone or they silently start reporting absence
 * (docs/reference/ssh-execution-boundary.md).
 */
export function isSshRequestOutcomeUnverifiable(error: unknown): boolean {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined
  return code === SSH_MUX_REQUEST_TIMEOUT_CODE || code === 'CONNECTION_LOST'
}

export class SshChannelMultiplexer {
  private decoder: FrameDecoder
  private transport: MultiplexerTransport
  private writer: SshMultiplexerTransportWriter
  private nextRequestId = 1
  private nextOutgoingSeq = 1
  private highestReceivedSeq = 0
  private highestAckedBySelf = 0
  private lastReceivedAt = Date.now()
  private pendingRequests = new Map<number, PendingRequest>()
  private readonly requestBarrier = new SshMultiplexerSettlementBarrier()
  private resetAcknowledgmentContext:
    | {
        token: object
        request?: RelayOwnerResetRequest
        acknowledgment?: Readonly<RelayOwnerResetAcknowledgment>
      }
    | undefined
  private readonly incomingRequests = new SshMultiplexerIncomingRequests()
  private readonly preparationAdmission = new SshPtyPreparationAdmission()
  private notificationHandlers: NotificationHandler[] = []
  private requestHandlers = new Map<string, RequestHandler>()
  // Why: per-method dispatch map keeps streaming consumers (fs.streamChunk,
  // fs.streamEnd, fs.streamError) from accreting string-match logic in the
  // generic notification listener that already serves fs.changed.
  private methodNotificationHandlers = new Map<string, Set<MethodNotificationHandler>>()
  private disposeHandlers: ((reason: 'shutdown' | 'connection_lost') => void)[] = []
  private connectionHealthTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  private disposeReason: 'shutdown' | 'connection_lost' | null = null
  private decoderReadPaused = false

  // Track the oldest unacked outgoing message timestamp
  private unackedTimestamps = new Map<number, number>()

  // Why: liveness probes (#7773) resolve on the first frame of any kind —
  // a keepalive ack proves the relay round-trip without a full RPC.
  private livenessProbeWaiters: { succeed: () => void; fail: () => void }[] = []

  constructor(transport: MultiplexerTransport) {
    this.transport = transport
    this.writer = new SshMultiplexerTransportWriter(
      transport,
      (error) => this.handleProtocolError(error),
      (saturated) => this.handleWriterSaturationChange(saturated)
    )

    this.decoder = new FrameDecoder(
      (frame) => this.handleFrame(frame),
      (err) => this.handleProtocolError(err),
      {
        pause: () => this.pauseDecoderReads(),
        resume: () => this.resumeDecoderReads()
      }
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
    this.startConnectionHealthTimer()
  }

  onNotification(handler: NotificationHandler): () => void {
    if (this.disposed) {
      return () => {}
    }
    this.notificationHandlers.push(handler)
    return () => {
      const idx = this.notificationHandlers.indexOf(handler)
      if (idx !== -1) {
        this.notificationHandlers.splice(idx, 1)
      }
    }
  }

  onNotificationByMethod(method: string, handler: MethodNotificationHandler): () => void {
    if (this.disposed) {
      return () => {}
    }
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

  onRequest(method: string, handler: RequestHandler): () => void {
    this.requestHandlers.set(method, handler)
    return () => {
      if (this.requestHandlers.get(method) === handler) {
        this.requestHandlers.delete(method)
      }
    }
  }

  // Why: the session needs to know when the relay channel dies so it can
  // auto-reconnect. Without this, a relay channel close (e.g. --connect
  // bridge exits) leaves the session in 'ready' state with a dead mux
  // and no recovery path — the SSH connection stays up so onStateChange
  // never fires the reconnect logic.
  onDispose(handler: (reason: 'shutdown' | 'connection_lost') => void): () => void {
    if (this.disposed) {
      // Why: a late subscriber must still learn the channel died; retaining it would leak the closure (#11953).
      try {
        handler(this.disposeReason ?? 'shutdown')
      } catch {
        // Don't let a handler error escape into the subscriber's registration path
      }
      return () => {}
    }
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
    options?: SshMultiplexerRequestOptions
  ): Promise<unknown> {
    if (this.disposed) {
      throw this.disposedError()
    }
    if (options?.signal?.aborted) {
      const error = new Error(`Request "${method}" was cancelled`) as Error & { name: string }
      error.name = 'AbortError'
      throw error
    }

    const id = this.nextRequestId++
    const controlId = this.preparationAdmission.admit(method, params)
    let resetRequest: RelayOwnerResetRequest | undefined
    if (method === RELAY_OWNER_RESET_METHOD || method === RELAY_PREPARED_RESET_RECOVERY_METHOD) {
      try {
        resetRequest = parseRelayOwnerResetRequest(params)
      } catch {
        // Malformed legacy calls still reach the host, but cannot mint identity-bound proof.
      }
    }
    const msg: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined
        ? { params: resetRequest ? { ...params, ...resetRequest } : params }
        : {})
    }
    const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS

    return new Promise((resolveRequest, rejectRequest) => {
      const token = {}
      this.requestBarrier.retain(token)
      const resolve = (result: unknown) => {
        this.requestBarrier.settle(token, { ok: true })
        resolveRequest(result)
      }
      const reject = (error: Error) => {
        this.preparationAdmission.recordFailure(controlId)
        this.requestBarrier.settle(token, { ok: false, error })
        rejectRequest(error)
      }
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
        reject(sshMuxRequestTimeoutError(method, timeoutMs))
      }, timeoutMs)

      if (options?.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true })
      }
      this.pendingRequests.set(id, {
        resetRequest,
        method,
        token,
        resolve,
        reject,
        beforeResolve: options?.beforeResolve,
        timer,
        cleanup
      })
      try {
        this.sendMessage(msg)
      } catch (error) {
        cleanup()
        this.pendingRequests.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Caller fences new mutations; this snapshots earlier writes and outstanding RPC responses. */
  async waitForPendingOperations(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.disposed) {
      throw this.disposedError()
    }
    const observer = new AbortController()
    const onAbort = () => observer.abort(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await Promise.all([
        this.writer.waitForPendingWrites(observer.signal),
        this.requestBarrier.wait(observer.signal)
      ])
      signal.throwIfAborted()
      if (this.disposed) {
        throw this.disposedError()
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      observer.abort()
    }
  }

  async fencePtyControlsAndDrain(id: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.preparationAdmission.close(id)
    await this.waitForPendingOperations(signal)
    this.preparationAdmission.assertSettled(id)
  }

  /** Permanent per transport; callers separately drain earlier operations before reset. */
  fenceForRelayReset(): void {
    this.preparationAdmission.closeForRelayReset()
    this.requestBarrier.retainFailureEvidence()
    this.writer.fenceForReset()
    this.incomingRequests.fenceForReset()
  }

  /** Only the exact reset response callback may exempt its own unsettled request. */
  assertRelayResetAcknowledgmentDrained(expected?: RelayOwnerResetRequest): void {
    const context = this.resetAcknowledgmentContext
    if (!context || !this.preparationAdmission.isRelayResetClosed) {
      throw new Error('ssh_mux_reset_acknowledgment_context_unproven')
    }
    if (expected !== undefined) {
      const request = parseRelayOwnerResetRequest(expected)
      if (
        !context.request ||
        Object.entries(request).some(
          ([key, value]) => context.request![key as keyof RelayOwnerResetRequest] !== value
        )
      ) {
        throw new Error('ssh_mux_reset_acknowledgment_request_mismatch')
      }
      parseRelayOwnerResetAcknowledgment(context.acknowledgment, request)
    }
    this.assertWriteSettlement()
    this.writer.assertPendingWritesSettled()
    this.requestBarrier.assertSettled(context.token)
    this.incomingRequests.assertResetDrained()
  }

  async waitForRelayResetDrain(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const observer = new AbortController()
    const onAbort = () => observer.abort(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await Promise.all([
        this.waitForPendingOperations(observer.signal),
        this.incomingRequests.waitForReset(observer.signal)
      ])
      signal.throwIfAborted()
      if (this.disposed) {
        throw this.disposedError()
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      observer.abort()
    }
  }

  isPtyPreparationFenced(id: string): boolean {
    return this.preparationAdmission.isClosed(id)
  }

  fencePtyPreparationSurface(surface: unknown): void {
    this.preparationAdmission.closeSurface(surface)
  }

  fencePtyCatalogCreation(): void {
    this.preparationAdmission.closeCatalogCreation()
  }

  async drainPtyCatalogCreation(signal: AbortSignal): Promise<void> {
    this.fencePtyCatalogCreation()
    await this.waitForPendingOperations(signal)
    this.preparationAdmission.assertCatalogCreationSettled()
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  notify(method: string, params?: Record<string, unknown>): void {
    this.preparationAdmission.admit(method, params, true)
    this.preparationAdmission.recordUnacknowledgedCreation(method)
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

  notifyWithSettlement(
    method: string,
    params: Record<string, unknown> | undefined,
    onSettled: (result: MultiplexerWriteSettlement) => void,
    isStillAdmitted?: () => boolean
  ): void {
    try {
      this.preparationAdmission.admit(method, params, true)
      this.preparationAdmission.recordUnacknowledgedCreation(method)
    } catch (error) {
      onSettled({ outcome: 'refused', reason: 'write_gate_denied', error: error as Error })
      return
    }
    if (this.disposed) {
      onSettled({
        outcome: 'refused',
        reason: 'transport_disposed',
        error: this.disposedError()
      })
      return
    }
    this.sendMessage(
      {
        jsonrpc: '2.0',
        method,
        ...(params !== undefined ? { params } : {})
      },
      onSettled,
      isStillAdmitted
    )
  }

  /**
   * Send a fresh keepalive and resolve true when any frame arrives before the
   * timeout. Used on system resume to distinguish a link that survived sleep
   * from a dead one before tearing the session down (#7773).
   */
  probeLiveness(timeoutMs: number): Promise<boolean> {
    if (this.disposed) {
      return Promise.resolve(false)
    }
    return new Promise<boolean>((resolve) => {
      const settle = (alive: boolean): void => {
        clearTimeout(timer)
        const idx = this.livenessProbeWaiters.indexOf(waiter)
        if (idx !== -1) {
          this.livenessProbeWaiters.splice(idx, 1)
        }
        resolve(alive)
      }
      const waiter = { succeed: () => settle(true), fail: () => settle(false) }
      const timer = setTimeout(() => settle(false), timeoutMs)
      this.livenessProbeWaiters.push(waiter)
      this.sendKeepAlive()
    })
  }

  dispose(reason: 'shutdown' | 'connection_lost' = 'shutdown'): void {
    if (this.disposed) {
      return
    }
    if (process.env.ORCA_SSH_MUX_DEBUG === '1') {
      console.warn(
        `[ssh-mux] Disposing multiplexer (reason: ${reason})`,
        new Error('dispose trace').stack
      )
    }
    this.disposed = true
    this.disposeReason = reason

    if (this.connectionHealthTimer) {
      clearInterval(this.connectionHealthTimer)
      this.connectionHealthTimer = null
    }

    for (const waiter of this.livenessProbeWaiters.splice(0)) {
      waiter.fail()
    }

    for (const [id, pending] of this.pendingRequests) {
      pending.cleanup()
      pending.reject(this.disposedError())
      this.pendingRequests.delete(id)
    }

    this.writer.dispose(this.disposedError())
    this.incomingRequests.dispose(this.disposedError())
    this.unackedTimestamps.clear()
    // Why: relay teardown can race with late provider registration; disposed
    // muxes must not retain provider/session closures through subscribers.
    this.notificationHandlers.length = 0
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

  assertWriteSettlement(): void {
    if (this.disposed) {
      throw this.disposedError()
    }
    if (this.transport.supportsWriteSettlement !== true) {
      throw new Error('ssh_mux_write_settlement_required')
    }
  }

  getSourceChannel(): object | undefined {
    return this.transport.sourceChannel
  }

  // ── Private ───────────────────────────────────────────────────────

  private disposedError(): Error & { code: string } {
    return createSshDisposalError(this.disposeReason ?? 'shutdown')
  }

  private sendMessage(
    msg: JsonRpcMessage,
    onSettled?: (result: MultiplexerWriteSettlement) => void,
    isStillAdmitted?: () => boolean
  ): void {
    const seq = this.nextOutgoingSeq++
    const frame = encodeJsonRpcFrame(msg, seq, this.highestReceivedSeq)
    this.trackOutgoingTimestamp(seq, false)
    this.writer.enqueue(
      frame,
      messageLane(msg),
      onSettled,
      isStillAdmitted,
      'method' in msg && msg.method === RELAY_NETWORK_TUNNEL_FRAME_METHOD
    )
  }

  private sendKeepAlive(): void {
    if (this.disposed) {
      return
    }
    const seq = this.nextOutgoingSeq
    const frame = encodeKeepAliveFrame(seq, this.highestReceivedSeq)
    if (!this.writer.enqueue(frame, 'liveness') || this.disposed) {
      return
    }
    this.nextOutgoingSeq++
    this.trackOutgoingTimestamp(seq, true)
  }

  private handleFrame(frame: DecodedFrame): void {
    // Why: any decoded frame proves the relay round-trip is alive; resolve
    // pending resume probes before ordinary dispatch (#7773).
    for (const waiter of this.livenessProbeWaiters.splice(0)) {
      waiter.succeed()
    }

    // Update ack tracking
    if (frame.id > this.highestReceivedSeq) {
      this.highestReceivedSeq = frame.id
    }

    // Header ACKs are untrusted uint32 values; work stays proportional to the
    // bounded set of sequence keys we actually retained.
    const acknowledgedSeq = Math.min(frame.ack, this.nextOutgoingSeq - 1)
    if (acknowledgedSeq > this.highestAckedBySelf) {
      for (const seq of this.unackedTimestamps.keys()) {
        if (seq <= acknowledgedSeq) {
          this.unackedTimestamps.delete(seq)
        }
      }
      this.highestAckedBySelf = acknowledgedSeq
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
    } else if ('id' in msg && 'method' in msg) {
      void this.handleRequest(msg as JsonRpcRequest)
    } else if ('method' in msg && !('id' in msg)) {
      this.handleNotification(msg as JsonRpcNotification)
    }
  }

  private async handleRequest(msg: JsonRpcRequest): Promise<void> {
    await this.incomingRequests.dispatch(
      msg,
      this.requestHandlers.get(msg.method),
      (response, settled) => this.sendMessage(response, settled)
    )
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
      const previousContext = this.resetAcknowledgmentContext
      try {
        this.resetAcknowledgmentContext =
          pending.method === RELAY_OWNER_RESET_METHOD ||
          pending.method === RELAY_PREPARED_RESET_RECOVERY_METHOD
            ? { token: pending.token, request: pending.resetRequest }
            : undefined
        if (this.resetAcknowledgmentContext && pending.resetRequest) {
          try {
            this.resetAcknowledgmentContext.acknowledgment = Object.freeze(
              parseRelayOwnerResetAcknowledgment(msg.result, pending.resetRequest)
            )
          } catch {
            // Preserve ordinary response handling; the identity-bound gate refuses invalid ACKs.
          }
        }
        pending.beforeResolve?.(msg.result)
        this.resetAcknowledgmentContext = previousContext
        pending.resolve(msg.result)
      } catch (error) {
        this.resetAcknowledgmentContext = previousContext
        pending.reject(error instanceof Error ? error : new Error(String(error)))
      } finally {
        this.resetAcknowledgmentContext = previousContext
      }
    }
  }

  private handleNotification(msg: JsonRpcNotification): void {
    const params = msg.params ?? {}
    // Why: handlers may unsubscribe during iteration (via the returned disposer
    // from onNotification / onNotificationByMethod), which mutates the live
    // collection and skips the next handler. Iterating a snapshot prevents that.
    const snapshot = Array.from(this.notificationHandlers)
    for (const handler of snapshot) {
      try {
        handler(msg.method, params)
      } catch (err) {
        // Why: relay notifications arrive on the SSH stream callback; one
        // bad subscriber must not escape as a main-process uncaught exception.
        console.warn(
          `[ssh-mux] Notification handler failed for ${msg.method}: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }
    const methodHandlers = this.methodNotificationHandlers.get(msg.method)
    if (methodHandlers && methodHandlers.size > 0) {
      const methodSnapshot = Array.from(methodHandlers)
      for (const handler of methodSnapshot) {
        try {
          handler(params)
        } catch (err) {
          // Why: file-stream and PTY listeners are per-method subscribers; keep
          // the mux alive even if one consumer rejects a malformed notification.
          console.warn(
            `[ssh-mux] Method notification handler failed for ${msg.method}: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
      }
    }
  }

  // Why: one 5s interval owns both the periodic keepalive and dead-link check,
  // halving per-connection timers while preserving their send-then-check order.
  private startConnectionHealthTimer(): void {
    let lastTickAt = Date.now()
    this.connectionHealthTimer = setInterval(() => {
      const now = Date.now()
      const sinceLastTick = now - lastTickAt
      lastTickAt = now
      // Why: after sleep/App Nap the pre-pause keepalive looks stale on the
      // first post-wake tick, killing a healthy link (#7773). Reset staleness
      // before this tick's fresh probe, then allow the next full window.
      const resumedAfterWake = sinceLastTick > WAKE_GAP_MS
      if (resumedAfterWake) {
        this.rebaseHealthClocks(now)
      }

      this.sendKeepAlive()

      // Why: a saturated writer used to suppress this check outright, which wedged a half-open
      // link forever — no drain, so no frame ever left, and the writer's single-outstanding
      // liveness guard silenced the one probe that could have noticed. The relay sends its own
      // keepalive every KEEPALIVE_SEND_MS, so a slow-but-alive peer still refreshes
      // lastReceivedAt; only a link that delivers nothing inbound is declared lost.
      if (this.disposed || resumedAfterWake || this.decoderReadPaused) {
        return
      }

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

  private trackOutgoingTimestamp(seq: number, liveness: boolean): void {
    const limit = liveness ? MAX_UNACKED_TIMESTAMPS : MAX_ORDINARY_UNACKED_TIMESTAMPS
    if (this.unackedTimestamps.size < limit) {
      this.unackedTimestamps.set(seq, Date.now())
    }
  }

  private pauseDecoderReads(): void {
    if (this.disposed || this.decoderReadPaused) {
      return
    }
    this.decoderReadPaused = true
    try {
      this.transport.pauseReads?.()
    } catch (error) {
      this.handleProtocolError(error)
    }
  }

  private resumeDecoderReads(): void {
    if (!this.decoderReadPaused) {
      return
    }
    this.decoderReadPaused = false
    if (this.disposed) {
      return
    }
    this.rebaseHealthClocks(Date.now())
    try {
      this.transport.resumeReads?.()
    } catch (error) {
      this.handleProtocolError(error)
    }
  }

  private handleWriterSaturationChange(saturated: boolean): void {
    if (!saturated && !this.disposed) {
      this.rebaseHealthClocks(Date.now())
    }
  }

  private rebaseHealthClocks(now: number): void {
    this.lastReceivedAt = now
    for (const seq of this.unackedTimestamps.keys()) {
      this.unackedTimestamps.set(seq, now)
    }
  }
}

function messageLane(msg: JsonRpcMessage): MultiplexerWriterLane {
  return 'method' in msg &&
    (msg.method === 'pty.data' || msg.method === RELAY_NETWORK_TUNNEL_FRAME_METHOD)
    ? 'ordinary'
    : 'control'
}
