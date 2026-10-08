import type { Readable, Writable } from 'node:stream'
import { z } from 'zod'
import {
  createIncrementalNdjsonFramer,
  encodeNdjson
} from '../../shared/main-process-ndjson-framer'
import {
  AcpAgentError,
  AcpConnectionClosedError,
  AcpInvalidResponseError,
  AcpRequestTimeoutError
} from './acp-errors'
import { AcpIncomingRequests } from './acp-incoming-requests'
import { requestTimeout, resolveAcpPeerOptions, type AcpPeerOptions } from './acp-peer-limits'
export type { AcpPeerOptions } from './acp-peer-limits'
import { settleOversizedAcpLine } from './acp-oversized-lines'
import { AcpWriteQueue } from './acp-write-queue'
import { detachAcpStreamErrorHandler } from './acp-stdio-error-boundary'

const idSchema = z.union([z.string(), z.number(), z.null()])
const errorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional()
})
const envelopeSchema = z.looseObject({
  jsonrpc: z.literal('2.0'),
  id: idSchema.optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional()
})
export type AcpJsonRpcMessage = z.infer<typeof envelopeSchema>
export type AcpRequestContext = { id: string | number | null; signal: AbortSignal }
export type AcpPeerHandlers = {
  // Void means handled; unsupported methods must throw AcpRpcError(-32601). The handler owns its
  // request: once the signal aborts it still answers, or throws (-32800); unanswered ends at close().
  onRequest?: (method: string, params: unknown, context: AcpRequestContext) => unknown
  onNotification?: (method: string, params: unknown) => void
  onDiagnostic?: (message: string) => void
  onClose?: (error: Error) => void
}
type Pending = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

export class AcpJsonRpcPeer {
  private readonly pending = new Map<number, Pending>()
  private readonly incoming: AcpIncomingRequests
  private readonly writer: AcpWriteQueue
  private readonly framer: ReturnType<typeof createIncrementalNdjsonFramer>
  private nextId = 1
  private terminalError?: Error
  private readonly maxLineBytes: number
  private readonly maxPending: number
  private readonly maxIncoming: number
  private readonly timeoutMs: number | null
  private readonly closeOnInputEnd: boolean

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly handlers: AcpPeerHandlers = {},
    options: AcpPeerOptions = {}
  ) {
    const limits = resolveAcpPeerOptions(options)
    this.maxLineBytes = limits.maxLineBytes
    this.maxPending = limits.maxPendingRequests
    this.maxIncoming = limits.maxIncomingRequests
    this.timeoutMs = limits.requestTimeoutMs
    this.closeOnInputEnd = limits.closeOnInputEnd
    this.writer = new AcpWriteQueue(output, limits.maxQueuedWriteBytes, (error) =>
      this.close(error)
    )
    this.incoming = new AcpIncomingRequests(
      handlers.onRequest,
      (message) => this.send(message),
      (error) => this.close(error),
      this.maxIncoming,
      (message) => this.diagnose(message)
    )
    this.framer = createIncrementalNdjsonFramer(
      (record) => this.dispatch(record),
      (rejected) =>
        rejected.kind === 'line-too-long'
          ? settleOversizedAcpLine(rejected, {
              rejectPending: (id, error) => this.rejectPending(id, error),
              refuse: (id, error) => this.incoming.refuse(id, error),
              close: (error) => this.close(error),
              diagnose: (message) => this.diagnose(message)
            })
          : this.diagnose(`Ignored ACP line: ${rejected.kind}`),
      { maxLineBytes: this.maxLineBytes }
    )
    input.setEncoding('utf8')
    input.on('data', this.onData)
    input.on('end', this.onInputEnd)
    input.on('close', this.onInputEnd)
    input.on('error', this.onError)
    output.on('close', this.onEnd)
    output.on('finish', this.onEnd)
    output.on('error', this.onError)
    if (
      (this.closeOnInputEnd && (input.destroyed || input.readableEnded)) ||
      output.destroyed ||
      !output.writable
    ) {
      this.onEnd()
    }
  }

  get closed(): boolean {
    return this.terminalError !== undefined
  }

  request(
    method: string,
    params: unknown,
    options: { timeoutMs?: number | null } = {}
  ): Promise<unknown> {
    if (this.terminalError) {
      return Promise.reject(this.terminalError)
    }
    if (this.pending.size >= this.maxPending) {
      return Promise.reject(new Error('ACP pending request capacity exceeded'))
    }
    let timeoutMs: number | null
    try {
      timeoutMs = requestTimeout(
        options.timeoutMs === undefined ? this.timeoutMs : options.timeoutMs
      )
    } catch (error) {
      return Promise.reject(error)
    }
    const id = this.nextId++
    const controller = new AbortController()
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id)
              const error = new AcpRequestTimeoutError(method)
              controller.abort(error)
              reject(error)
            }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      void this.send({ jsonrpc: '2.0', id, method, params }, controller.signal).catch((error) => {
        const pending = this.pending.get(id)
        if (!pending) {
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

  /** Aborts every open agent request's signal; each handler still sends its own answer. */
  cancelIncomingRequests(): void {
    this.incoming.cancel()
  }

  close(error: Error = new AcpConnectionClosedError()): void {
    if (this.terminalError) {
      return
    }
    this.terminalError = error
    this.input.removeListener('data', this.onData)
    this.input.removeListener('end', this.onInputEnd)
    this.input.removeListener('close', this.onInputEnd)
    detachAcpStreamErrorHandler(this.input, this.onError)
    this.output.removeListener('close', this.onEnd)
    this.output.removeListener('finish', this.onEnd)
    detachAcpStreamErrorHandler(this.output, this.onError)
    this.framer.reset()
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
  private readonly onInputEnd = (): void => {
    if (this.closeOnInputEnd) {
      this.close()
    }
  }
  private readonly onError = (error: Error): void => this.close(error)
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
      return this.writer.write(encodeNdjson(message, this.maxLineBytes), signal)
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
    if (this.closed) {
      return
    }
    const parsed = envelopeSchema.safeParse(record)
    if (!parsed.success) {
      this.diagnose('Ignored invalid ACP JSON-RPC envelope')
      const response = z
        .object({ id: z.number(), method: z.undefined().optional() })
        .safeParse(record)
      if (response.success) {
        this.rejectPending(response.data.id, invalidEnvelope(record))
      }
      return
    }
    const frame = parsed.data
    if (frame.method !== undefined) {
      if ('result' in frame || 'error' in frame) {
        this.diagnose('Ignored invalid ACP request')
        return
      }
      if (frame.id !== undefined) {
        this.incoming.handle(frame.id, frame.method, frame.params)
        return
      }
      try {
        this.handlers.onNotification?.(frame.method, frame.params)
      } catch (error) {
        this.diagnose(`ACP notification handler failed: ${String(error)}`)
      }
      return
    }
    if ('result' in frame === 'error' in frame) {
      this.diagnose('Ignored invalid ACP response')
      if (typeof frame.id === 'number') {
        this.rejectPending(frame.id, invalidEnvelope(record))
      }
      return
    }
    if (typeof frame.id !== 'number') {
      return
    }
    const pending = this.pending.get(frame.id)
    if (!pending) {
      return
    }
    this.pending.delete(frame.id)
    clearTimeout(pending.timer)
    if ('error' in frame) {
      const parsedError = errorSchema.safeParse(frame.error)
      if (!parsedError.success) {
        this.diagnose('Invalid ACP error response')
        pending.reject(new AcpInvalidResponseError('Invalid ACP error response', frame.error))
      } else {
        const error = parsedError.data
        pending.reject(new AcpAgentError(error.code, error.message, error.data))
      }
    } else {
      pending.resolve(frame.result)
    }
  }
}

function invalidEnvelope(raw: unknown): () => Error {
  return () => new AcpInvalidResponseError('Invalid ACP response envelope', raw)
}
