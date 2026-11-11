import type { Readable, Writable } from 'node:stream'
import {
  readAcpResponse,
  type AcpResponse,
  type AcpRequestOptions,
  type AcpPendingResponse
} from './acp-response-settlement'

import {
  createIncrementalNdjsonFramer,
  encodeNdjson
} from '../../../shared/main-process-ndjson-framer'
import { AcpConnectionClosedError, startAcpRequestDeadline } from './acp-errors'
import { AcpIncomingRequests } from './acp-incoming-requests'
import { requestTimeout, resolveAcpPeerOptions, type AcpPeerOptions } from './acp-peer-limits'

import { settleOversizedAcpLine } from './acp-oversized-lines'
import { AcpWriteQueue } from './acp-write-queue'
import { detachProviderStreamErrorHandler } from '../../provider-process/provider-stdio-error-boundary'
import { ProviderOutputEnd } from '../../provider-process/provider-output-end'
import { acpRpcEnvelopeSchema, type AcpJsonRpcMessage } from './acp-rpc-envelope'
import { rejectUnreadableAcpReply, settleAcpReply } from './acp-peer-reply'

export type AcpRequestContext = { id: string | number | null; signal: AbortSignal }
export type AcpPeerHandlers = {
  // Void is handled; unsupported methods throw -32601. Aborted handlers still reply or throw -32800.
  onRequest?: (method: string, params: unknown, context: AcpRequestContext) => unknown
  onNotification?: (method: string, params: unknown) => void
  onDiagnostic?: (message: string) => void
  onClose?: (error: Error) => void
  /** Bounds how long calls outstanding when the agent stopped reading wait for answers it wrote;
   *  `finish` settles them. Defaults to the drain of the agent's output. */
  onOutputEnd?: (error: Error, finish: () => void) => void
  /** Includes non-protocol output and unterminated final lines. */
  onOtherLine?: (line: string, cut?: boolean) => void
}
export class AcpJsonRpcPeer {
  private readonly pending = new Map<number, AcpPendingResponse>()
  private readonly incoming: AcpIncomingRequests
  private readonly writer: AcpWriteQueue
  private readonly framer: ReturnType<typeof createIncrementalNdjsonFramer>
  private nextId = 1
  private terminalError?: Error
  private readonly outputEnd: ProviderOutputEnd
  private drainingNotifications = false
  private readonly limits: Required<AcpPeerOptions>

  constructor(
    private readonly input: Readable,
    output: Writable,
    private readonly handlers: AcpPeerHandlers = {},
    options: AcpPeerOptions = {}
  ) {
    const limits = resolveAcpPeerOptions(options)
    this.limits = limits
    this.writer = new AcpWriteQueue(output, limits.maxQueuedWriteBytes, (error) =>
      this.endOutput(error)
    )
    this.incoming = new AcpIncomingRequests(
      handlers.onRequest,
      (message) => this.send(message),
      (error) => this.close(error),
      this.limits.maxIncomingRequests,
      (message) => this.diagnose(message)
    )
    this.framer = createIncrementalNdjsonFramer(
      (record) => this.dispatch(record),
      (rejected) => {
        if (rejected.kind === 'line-too-long') {
          this.handlers.onOtherLine?.(rejected.prefix, true)
          settleOversizedAcpLine(rejected, {
            rejectPending: (id, error) => this.rejectPending(id, error),
            refuse: (id, error) => this.incoming.refuse(id, error),
            close: (error) => this.close(error),
            diagnose: (message) => this.diagnose(message)
          })
        } else {
          this.otherLine(rejected.line)
        }
      },
      { maxLineBytes: this.limits.maxLineBytes }
    )
    input.setEncoding('utf8')
    input.on('data', this.onData)
    input.on('end', this.onInputEnd)
    input.on('close', this.onInputEnd)
    input.on('error', this.onError)
    this.outputEnd = new ProviderOutputEnd(
      output,
      (error) => this.endOutput(error),
      () => new AcpConnectionClosedError()
    )
    if (this.limits.closeOnInputEnd && (input.destroyed || input.readableEnded)) {
      this.onEnd()
    } else if (output.destroyed || !output.writable) {
      this.endOutput(new AcpConnectionClosedError())
    }
  }

  get closed(): boolean {
    return this.terminalError !== undefined
  }

  request<T>(method: string, params: unknown, options: AcpRequestOptions<T>): Promise<T>
  request(
    method: string,
    params: unknown,
    options?: Pick<AcpRequestOptions, 'timeoutMs' | 'onTimeout'>
  ): Promise<unknown>
  request(
    method: string,
    params: unknown,
    options: Partial<AcpRequestOptions> = {}
  ): Promise<unknown> {
    if (this.terminalError ?? this.outputEnd.error) {
      return Promise.reject(this.terminalError ?? this.outputEnd.error)
    }
    if (this.pending.size >= this.limits.maxPendingRequests) {
      return Promise.reject(new Error('ACP pending request capacity exceeded'))
    }
    let timeoutMs: number | null
    try {
      timeoutMs = requestTimeout(
        options.timeoutMs === undefined ? this.limits.requestTimeoutMs : options.timeoutMs
      )
    } catch (error) {
      return Promise.reject(error)
    }
    const id = this.nextId++
    const controller = new AbortController()
    return new Promise((resolve, reject) => {
      const settle = (response: AcpResponse): void => {
        try {
          resolve(readAcpResponse(response, options.settle))
        } catch (error) {
          reject(error)
        }
      }
      const timer = startAcpRequestDeadline(method, timeoutMs, (error) => {
        this.pending.delete(id)
        if (options.onTimeout === 'cancel') {
          // Cutting a line mid-write ends the stream, so the cancel follows the call instead.
          void this.notify('$/cancel_request', { requestId: id }).catch(() => {})
        } else {
          controller.abort(error)
        }
        reject(error)
      })
      this.pending.set(id, {
        method,
        resolve: (value) => settle({ value }),
        reject: (error) => settle({ error }),
        timer
      })
      void this.send({ jsonrpc: '2.0', id, method, params }, controller.signal).catch((error) => {
        const pending = this.pending.get(id)
        // A write lost to the agent no longer reading leaves the call to the output drain.
        if (!pending || this.outputEnd.error) {
          return
        }
        this.pending.delete(id)
        clearTimeout(timer)
        pending.reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  notify(method: string, params: unknown): Promise<void> {
    return this.send({ jsonrpc: '2.0', method, params })
  }

  /** Aborts signals; handlers still own replies. */
  cancelIncomingRequests(): void {
    this.incoming.cancel()
  }

  close(error: Error = new AcpConnectionClosedError()): void {
    this.shutdown(error, false)
  }

  /** Reject calls immediately; the process owner bounds how long final notifications can arrive. */
  drainNotifications(error: Error = new AcpConnectionClosedError()): void {
    this.shutdown(error, true)
  }

  private shutdown(error: Error, drainNotifications: boolean): void {
    if (this.terminalError && (!this.drainingNotifications || drainNotifications)) {
      return
    }
    this.drainingNotifications = drainNotifications
    if (!drainNotifications) {
      this.input.removeListener('data', this.onData)
      this.input.removeListener('end', this.onInputEnd)
      this.input.removeListener('close', this.onInputEnd)
      detachProviderStreamErrorHandler(this.input, this.onError)
      this.framer.reset()
    }
    if (this.terminalError) {
      return
    }
    this.outputEnd.detach()
    this.terminalError = error
    this.writer.close(error)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.incoming.close(error)
    try {
      this.handlers.onClose?.(error)
    } catch (failure) {
      this.diagnose(String(failure))
    }
  }

  private readonly onData = (chunk: string): void => {
    try {
      this.framer.feed(chunk)
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)))
    }
  }
  private readonly onEnd = (): void => this.close()

  private endOutput(error: Error): void {
    if (this.terminalError || !this.outputEnd.begin(error)) {
      return
    }
    this.writer.close(error)
    this.outputEnd.settle(
      this.pending.size > 0,
      this.input,
      () => this.close(error),
      this.handlers.onOutputEnd && ((finish) => this.handlers.onOutputEnd?.(error, finish))
    )
  }
  private readonly onInputEnd = (): void => {
    const tail = this.framer.takeTail()
    if (tail.trim()) {
      this.otherLine(tail)
    }
    if (this.limits.closeOnInputEnd) {
      this.close(this.outputEnd.error)
    }
  }
  private readonly onError = (error: Error): void => this.close(error)
  private otherLine(line: string): void {
    this.handlers.onOtherLine?.(line)
    this.diagnose('Ignored ACP line: invalid-json')
  }
  private diagnose(message: string): void {
    try {
      this.handlers.onDiagnostic?.(message)
    } catch {
      /* Diagnostics cannot break the transport. */
    }
  }

  private send(message: AcpJsonRpcMessage, signal?: AbortSignal): Promise<void> {
    if (this.terminalError) {
      return Promise.reject(this.terminalError)
    }
    try {
      return this.writer.write(encodeNdjson(message, this.limits.maxLineBytes), signal)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  private rejectPending(id: number, error: (method: string) => Error): void {
    const pending = this.pending.get(id)
    if (pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(error(pending.method))
    }
  }

  private dispatch(record: unknown): void {
    if (this.closed && !this.drainingNotifications) {
      return
    }
    const parsed = acpRpcEnvelopeSchema.safeParse(record)
    if (!parsed.success) {
      this.diagnose('Ignored invalid ACP JSON-RPC envelope')
      rejectUnreadableAcpReply(record, (id, error) => this.rejectPending(id, error))
      return
    }
    const frame = parsed.data
    if (this.drainingNotifications && (frame.id !== undefined || frame.method === undefined)) {
      return
    }
    if (frame.method !== undefined) {
      if ('result' in frame || 'error' in frame) {
        this.diagnose('Ignored invalid ACP request')
        return
      }
      if (frame.id !== undefined) {
        this.incoming.handle(frame.id, frame.method, frame.params)
        return
      }
      if (frame.method === '$/cancel_request') {
        this.incoming.cancelRequested(frame.params)
        return
      }
      try {
        this.handlers.onNotification?.(frame.method, frame.params)
      } catch (error) {
        this.diagnose(`ACP notification handler failed: ${String(error)}`)
      }
      return
    }
    settleAcpReply({
      record,
      frame,
      pending: this.pending,
      rejectPending: (id, error) => this.rejectPending(id, error),
      diagnose: (message) => this.diagnose(message)
    })
    if (this.outputEnd.error && this.pending.size === 0) {
      this.close(this.outputEnd.error)
    }
  }
}
