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

type PendingRequest = {
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
export type RequestHandler = (params: Record<string, unknown>) => Promise<unknown> | unknown

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

export function isSshMuxRequestTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === SSH_MUX_REQUEST_TIMEOUT_CODE
  )
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
  private notificationHandlers: NotificationHandler[] = []
  private requestHandlers = new Map<string, RequestHandler>()
  // Why: per-method dispatch map keeps streaming consumers (fs.streamChunk,
  // fs.streamEnd, fs.streamError) from accreting string-match logic in the
  // generic notification listener that already serves fs.changed.
  private methodNotificationHandlers = new Map<string, Set<MethodNotificationHandler>>()
  private disposeHandlers: ((reason: 'shutdown' | 'connection_lost') => void)[] = []
  private connectionHealthTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  private decoderReadPaused = false
  private writerSaturated = false

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
        reject(sshMuxRequestTimeoutError(method, timeoutMs))
      }, timeoutMs)

      if (options?.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true })
      }
      this.pendingRequests.set(id, {
        resolve,
        reject,
        beforeResolve: options?.beforeResolve,
        timer,
        cleanup
      })
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

  notifyWithSettlement(
    method: string,
    params: Record<string, unknown> | undefined,
    onSettled: (result: { ok: true } | { ok: false; error: Error }) => void
  ): void {
    if (this.disposed) {
      onSettled({ ok: false, error: new Error('Multiplexer disposed') })
      return
    }
    this.sendMessage(
      {
        jsonrpc: '2.0',
        method,
        ...(params !== undefined ? { params } : {})
      },
      onSettled
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

    if (this.connectionHealthTimer) {
      clearInterval(this.connectionHealthTimer)
      this.connectionHealthTimer = null
    }

    // Why: the renderer uses the error code to distinguish temporary disconnects
    // (show reconnection overlay) from permanent shutdown (show error toast).
    const errorMessage =
      reason === 'connection_lost' ? 'SSH connection lost, reconnecting...' : 'Multiplexer disposed'
    const errorCode = reason === 'connection_lost' ? 'CONNECTION_LOST' : 'DISPOSED'

    for (const waiter of this.livenessProbeWaiters.splice(0)) {
      waiter.fail()
    }

    for (const [id, pending] of this.pendingRequests) {
      pending.cleanup()
      const err = new Error(errorMessage) as Error & { code: string }
      err.code = errorCode
      pending.reject(err)
      this.pendingRequests.delete(id)
    }

    const writerError = new Error(errorMessage) as Error & { code: string }
    writerError.code = errorCode
    this.writer.dispose(writerError)
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

  // ── Private ───────────────────────────────────────────────────────

  private sendMessage(
    msg: JsonRpcMessage,
    onSettled?: (result: MultiplexerWriteSettlement) => void
  ): void {
    const seq = this.nextOutgoingSeq++
    const frame = encodeJsonRpcFrame(msg, seq, this.highestReceivedSeq)
    this.trackOutgoingTimestamp(seq, false)
    this.writer.enqueue(frame, messageLane(msg), onSettled)
  }

  private sendKeepAlive(): void {
    if (this.disposed) {
      return
    }
    const seq = this.nextOutgoingSeq
    const frame = encodeKeepAliveFrame(seq, this.highestReceivedSeq)
    if (!this.writer.enqueue(frame, 'liveness')) {
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
    const handler = this.requestHandlers.get(msg.method)
    if (!handler) {
      this.sendMessage({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` }
      })
      return
    }

    try {
      const result = await handler(msg.params ?? {})
      this.sendMessage({
        jsonrpc: '2.0',
        id: msg.id,
        result: result ?? null
      })
    } catch (err) {
      this.sendMessage({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: (err as { code?: number }).code ?? -32000,
          message: err instanceof Error ? err.message : String(err)
        }
      })
    }
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
      try {
        pending.beforeResolve?.(msg.result)
        pending.resolve(msg.result)
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)))
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

      if (this.disposed || resumedAfterWake || this.decoderReadPaused || this.writerSaturated) {
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
    this.writerSaturated = saturated
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
  return 'method' in msg && msg.method === 'pty.data' ? 'ordinary' : 'control'
}
