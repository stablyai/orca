/* eslint-disable max-lines -- Why: the SSH relay protocol state machine keeps
   request, notification, keepalive, and cancellation semantics paired. */
import { FrameDecoder, type DecodedFrame } from '../../shared/relay-frame-decoder'
import {
  MessageType,
  encodeJsonRpcFrame,
  encodeKeepAliveFrame,
  parseJsonRpcMessage,
  KEEPALIVE_SEND_MS,
  TIMEOUT_MS,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcNotification
} from './remote-exec/remote-frame-protocol'
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

type SshMultiplexerRequestOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  beforeResolve?: (result: unknown) => void
}

export type NotificationHandler = (method: string, params: Record<string, unknown>) => void
type MethodNotificationHandler = (params: Record<string, unknown>) => void
type RequestHandler = (params: Record<string, unknown>) => unknown

type MultiplexerDisposeReason = 'shutdown' | 'connection_lost'

// Centralize disposal errors so every producer preserves reconnect-overlay vs permanent-shutdown handling.
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
// Long tick gaps mean sleep/App Nap, not link death (#7773).
const WAKE_GAP_MS = KEEPALIVE_SEND_MS * 3

// Use typed request timeout identity; matching wording misclassified unrelated failures.
export const SSH_MUX_REQUEST_TIMEOUT_CODE = 'SSH_MUX_REQUEST_TIMEOUT'

function sshMuxRequestTimeoutError(method: string, timeoutMs: number): Error {
  return Object.assign(new Error(`Request "${method}" timed out after ${timeoutMs}ms`), {
    code: SSH_MUX_REQUEST_TIMEOUT_CODE
  })
}

/** Timeout or connection loss can hide completed host work. Both mean unverifiable, never absent; callers must classify this broader outcome (docs/reference/ssh-execution-boundary.md). */
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
  private notificationHandlers: NotificationHandler[] = []
  private requestHandlers = new Map<string, RequestHandler>()
  // Dispatch streaming subscribers by method without adding branches to the generic fs.changed listener.
  private methodNotificationHandlers = new Map<string, Set<MethodNotificationHandler>>()
  private disposeHandlers: ((reason: 'shutdown' | 'connection_lost') => void)[] = []
  private connectionHealthTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  private disposeReason: 'shutdown' | 'connection_lost' | null = null
  private decoderReadPaused = false

  private unackedTimestamps = new Map<number, number>()

  // Any inbound frame, including keepalive ACK, proves resume liveness without an RPC.
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

  // Channel closure must notify the session: SSH itself may remain connected, so connection-state handlers cannot recover a dead mux.
  onDispose(handler: (reason: 'shutdown' | 'connection_lost') => void): () => void {
    if (this.disposed) {
      // Notify late subscribers immediately instead of retaining dead-session closures (#11953).
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
        // Cancel host-side filesystem work too; rejecting only this promise leaves scans running.
        this.notify('rpc.cancel', { id })
        const error = new Error(`Request "${method}" was cancelled`) as Error & { name: string }
        error.name = 'AbortError'
        pending.reject(error)
      }
      timer = setTimeout(() => {
        const pending = this.pendingRequests.get(id)
        if (pending) {
          pending.cleanup()
          // Stop host-side work on timeout rather than merely ignoring its reply.
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
    onSettled: (result: MultiplexerWriteSettlement) => void
  ): void {
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
      onSettled
    )
  }

  /** Probe after resume before teardown: any fresh inbound frame proves a surviving relay link (#7773). */
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
    this.unackedTimestamps.clear()
    // Clear subscribers during teardown so late provider registration cannot leak session closures.
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

  private disposedError(): Error & { code: string } {
    return createSshDisposalError(this.disposeReason ?? 'shutdown')
  }

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
    // Resolve resume probes on any decoded frame before ordinary dispatch (#7773).
    for (const waiter of this.livenessProbeWaiters.splice(0)) {
      waiter.succeed()
    }

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
    // Snapshot handlers because unsubscribe during dispatch would skip successors.
    const snapshot = Array.from(this.notificationHandlers)
    for (const handler of snapshot) {
      try {
        handler(msg.method, params)
      } catch (err) {
        // Contain subscriber exceptions inside the SSH stream callback so they cannot crash main.
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
          // A malformed file/PTY notification must not kill the mux when its consumer throws.
          console.warn(
            `[ssh-mux] Method notification handler failed for ${msg.method}: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
      }
    }
  }

  // One timer preserves keepalive-send-before-health-check order while halving per-connection timers.
  private startConnectionHealthTimer(): void {
    let lastTickAt = Date.now()
    this.connectionHealthTimer = setInterval(() => {
      const now = Date.now()
      const sinceLastTick = now - lastTickAt
      lastTickAt = now
      // After sleep/App Nap reset old staleness before probing, then allow a full health window (#7773).
      const resumedAfterWake = sinceLastTick > WAKE_GAP_MS
      if (resumedAfterWake) {
        this.rebaseHealthClocks(now)
      }

      this.sendKeepAlive()

      // Never skip health checks for outbound saturation: inbound peer keepalives prove slow-but-live links; total inbound silence detects wedges.
      if (this.disposed || resumedAfterWake || this.decoderReadPaused) {
        return
      }

      const noDataReceived = now - this.lastReceivedAt > TIMEOUT_MS

      let oldestUnacked = Infinity
      for (const ts of this.unackedTimestamps.values()) {
        if (ts < oldestUnacked) {
          oldestUnacked = ts
        }
      }
      const oldestUnackedStale = oldestUnacked !== Infinity && now - oldestUnacked > TIMEOUT_MS

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
  return 'method' in msg && msg.method === 'pty.data' ? 'ordinary' : 'control'
}
