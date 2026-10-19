import type { Readable, Writable } from 'node:stream'
import { z } from 'zod'
import {
  createIncrementalNdjsonFramer,
  encodeNdjson
} from '../../shared/main-process-ndjson-framer'
import { detachProviderStreamErrorHandler } from '../provider-process/provider-stdio-error-boundary'
import { ProviderStdioWriteQueue } from '../provider-process/provider-stdio-write-queue'
import {
  jsonlRpcRequestTimeout,
  resolveJsonlRpcPeerOptions,
  type JsonlRpcPeerOptions
} from './peer-limits'

const recordSchema = z.looseObject({ type: z.string() })
const responseSchema = z.looseObject({
  type: z.literal('response'),
  id: z.string().optional(),
  command: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional()
})

export type JsonlRpcRecord = z.infer<typeof recordSchema>
export class JsonlRpcStreamClosedError extends Error {
  constructor() {
    super('Agent JSON-lines RPC stream closed')
    this.name = 'JsonlRpcStreamClosedError'
  }
}
export class JsonlRpcResponseError extends Error {
  constructor(
    readonly command: string,
    message: string
  ) {
    super(message)
    this.name = 'JsonlRpcResponseError'
  }
}
export type JsonlRpcPeerHandlers = {
  /** Includes deferred prompt acknowledgements without an id. */
  /** A dialect failure is fatal: continuing would discard session or tool lifecycle evidence. */
  onRecord?: (record: JsonlRpcRecord) => void
  onClose?: (error: Error) => void
  onDiagnostic?: (message: string) => void
}
type PendingRequest = {
  command: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

/** Transport only: a dialect owns turns, dialogs, and session handles. */
export class JsonlRpcPeer {
  private readonly limits: Required<JsonlRpcPeerOptions>
  private readonly pending = new Map<string, PendingRequest>()
  private readonly writer: ProviderStdioWriteQueue
  private readonly framer: ReturnType<typeof createIncrementalNdjsonFramer>
  private nextId = 0
  private terminalError?: Error
  private inputEndError?: Error
  private readingPaused = false

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly handlers: JsonlRpcPeerHandlers = {},
    options: JsonlRpcPeerOptions = {}
  ) {
    this.limits = resolveJsonlRpcPeerOptions(options)
    this.writer = new ProviderStdioWriteQueue(
      output,
      this.limits.maxQueuedWriteBytes,
      (error) => this.close(error),
      {
        capacity: () => new Error('JSON-lines RPC write queue capacity exceeded'),
        closed: () => new Error('JSON-lines RPC output is not writable')
      }
    )
    this.framer = createIncrementalNdjsonFramer(
      (record) => this.dispatch(record),
      (rejected) => {
        if (rejected.kind === 'line-too-long') {
          this.close(new Error('JSON-lines RPC record exceeded the size limit'))
        } else {
          this.diagnose('Ignored non-JSON agent output')
        }
      },
      {
        maxLineBytes: this.limits.maxLineBytes,
        shouldPause: () => this.readingPaused || this.closed
      }
    )
    input.setEncoding('utf8')
    input.on('data', this.onData)
    input.on('end', this.onEnd)
    input.on('close', this.onEnd)
    input.on('error', this.onError)
    output.on('finish', this.onEnd)
    output.on('close', this.onEnd)
    output.on('error', this.onError)
    if (input.destroyed || input.readableEnded || output.destroyed || !output.writable) {
      this.onEnd()
    }
  }

  get closed(): boolean {
    return this.terminalError !== undefined
  }

  /** A process exit can precede the last bytes already written to stdout. */
  finishOnInputEnd(error: Error): void {
    this.inputEndError = error
  }

  pauseReading(): void {
    this.readingPaused = true
    this.input.pause()
  }

  resumeReading(): void {
    if (this.closed) {
      return
    }
    this.readingPaused = false
    try {
      this.framer.resume()
      if (!this.readingPaused && !this.closed) {
        this.input.resume()
      }
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)))
    }
  }

  request(
    command: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number | null } = {}
  ): Promise<unknown> {
    if (this.terminalError) {
      return Promise.reject(this.terminalError)
    }
    if (this.pending.size >= this.limits.maxPendingRequests) {
      return Promise.reject(new Error('JSON-lines RPC pending request capacity exceeded'))
    }
    let timeoutMs: number | null
    try {
      timeoutMs =
        options.timeoutMs === null
          ? null
          : jsonlRpcRequestTimeout(options.timeoutMs ?? this.limits.requestTimeoutMs)
    } catch (error) {
      return Promise.reject(error)
    }
    const id = `orca-${++this.nextId}`
    const controller = new AbortController()
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id)
              const error = new Error(`Agent did not answer ${command} in time`)
              controller.abort(error)
              reject(error)
            }, timeoutMs)
      timer?.unref()
      this.pending.set(id, { command, resolve, reject, timer })
      void this.send({ ...params, type: command, id }, controller.signal).catch(
        (error: unknown) => {
          this.rejectPending(id, error instanceof Error ? error : new Error(String(error)))
        }
      )
    })
  }

  /** The dialect may track acknowledgements independently of transport correlation. */
  send(record: JsonlRpcRecord, signal?: AbortSignal): Promise<void> {
    if (this.terminalError) {
      return Promise.reject(this.terminalError)
    }
    try {
      return this.writer.write(encodeNdjson(record, this.limits.maxLineBytes), signal)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  close(error: Error = new Error('Agent JSON-lines RPC stream closed')): void {
    if (this.terminalError) {
      return
    }
    this.terminalError = error
    this.input.removeListener('data', this.onData)
    this.input.removeListener('end', this.onEnd)
    this.input.removeListener('close', this.onEnd)
    detachProviderStreamErrorHandler(this.input, this.onError)
    this.output.removeListener('finish', this.onEnd)
    this.output.removeListener('close', this.onEnd)
    detachProviderStreamErrorHandler(this.output, this.onError)
    this.framer.reset()
    this.writer.close(error)
    for (const id of this.pending.keys()) {
      this.rejectPending(id, error)
    }
    try {
      this.handlers.onClose?.(error)
    } catch {
      this.diagnose('Agent RPC close observer failed')
    }
  }

  private readonly onData = (chunk: string): void => {
    try {
      this.framer.feed(chunk)
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)))
    }
  }
  private readonly onEnd = (): void =>
    this.close(this.inputEndError ?? new JsonlRpcStreamClosedError())
  private readonly onError = (error: Error): void => this.close(error)

  private diagnose(message: string): void {
    try {
      this.handlers.onDiagnostic?.(message)
    } catch {
      /* Diagnostics cannot break cleanup. */
    }
  }

  private rejectPending(id: string, error: Error): void {
    const pending = this.pending.get(id)
    if (!pending) {
      return
    }
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.reject(error)
  }

  private dispatch(value: unknown): void {
    if (this.closed) {
      return
    }
    const parsed = recordSchema.safeParse(value)
    if (!parsed.success) {
      const identified = z.object({ id: z.string() }).safeParse(value)
      if (identified.success) {
        this.rejectPending(identified.data.id, new Error('Invalid agent RPC response'))
      }
      this.diagnose('Ignored invalid agent RPC record')
      return
    }
    const record = parsed.data
    if (
      record.type !== 'response' &&
      record.type !== 'extension_ui_request' &&
      typeof record.id === 'string' &&
      this.pending.has(record.id) &&
      (Object.hasOwn(record, 'command') || Object.hasOwn(record, 'success'))
    ) {
      this.rejectPending(record.id, new Error('Invalid agent RPC response'))
      return
    }
    if (record.type === 'response' && typeof record.id === 'string') {
      const pending = this.pending.get(record.id)
      if (!pending) {
        return
      }
      const response = responseSchema.safeParse(record)
      if (!response.success || response.data.command !== pending.command) {
        this.rejectPending(record.id, new Error('Invalid agent RPC response'))
        return
      }
      this.pending.delete(record.id)
      clearTimeout(pending.timer)
      if (response.data.success) {
        pending.resolve(response.data.data)
      } else {
        pending.reject(
          new JsonlRpcResponseError(
            pending.command,
            response.data.error ?? `Agent rejected ${pending.command}`
          )
        )
      }
      return
    }
    this.handlers.onRecord?.(record)
  }
}
