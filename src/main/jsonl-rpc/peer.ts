import { createProviderSourceCompletion } from '../provider-process/provider-source-completion'
import type { Readable, Writable } from 'node:stream'
import {
  dispatchJsonlRpcRecord,
  type JsonlRpcRecord,
  type JsonlRpcPendingRequest
} from './peer-record-dispatch'
export { JsonlRpcResponseError, type JsonlRpcRecord } from './peer-record-dispatch'
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
import { settleOversizedJsonlRecord, type JsonlRpcRequestOptions } from './peer-oversized-record'

export class JsonlRpcStreamClosedError extends Error {
  constructor() {
    super('Agent JSON-lines RPC stream closed')
    this.name = 'JsonlRpcStreamClosedError'
  }
}
export type JsonlRpcPeerHandlers = {
  /** Includes id-less deferred prompt acknowledgements; dialect failures are fatal to preserve lifecycle evidence. */
  onRecord?: (record: JsonlRpcRecord) => void
  /** An event over the line limit was dropped, leaving only its bounded prefix; the stream stays open. */
  onOversizedEvent?: (type: string, prefix: string) => void
  onClose?: (error: Error) => void
  onDiagnostic?: (message: string) => void
}
/** Transport only: a dialect owns turns, dialogs, and session handles. */
export class JsonlRpcPeer {
  private readonly limits: Required<JsonlRpcPeerOptions>
  private readonly pending = new Map<string, JsonlRpcPendingRequest>()
  private readonly writer: ProviderStdioWriteQueue
  private readonly framer: ReturnType<typeof createIncrementalNdjsonFramer>
  private nextId = 0
  private nextOptionalId = 0
  private closing = false
  private terminalError?: Error
  private inputEndError?: Error
  private readingPaused = false
  private readonly source: ReturnType<typeof createProviderSourceCompletion>

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
          settleOversizedJsonlRecord(rejected, {
            highestOptionalAssigned: this.nextOptionalId,
            maxLineBytes: this.limits.maxLineBytes,
            pendingCommand: (id) => this.pending.get(id)?.command,
            rejectPending: (id, error) => this.rejectPending(id, error),
            skipEvent: (type) => {
              this.diagnose(`Skipped oversized agent RPC event: ${type}`)
              this.handlers.onOversizedEvent?.(type, rejected.prefix)
            },
            close: (error) => this.close(error)
          })
        } else {
          this.diagnose('Ignored non-JSON agent output')
        }
      },
      {
        maxLineBytes: this.limits.maxLineBytes,
        shouldPause: () => this.readingPaused || this.closed
      }
    )
    this.source = createProviderSourceCompletion(input, {
      data: this.onData,
      end: (natural) => {
        this.framer.finish(natural)
        this.onEnd()
      },
      error: this.onError,
      draining: () => {
        this.readingPaused = false
        this.framer.drain()
      }
    })
    output.on('finish', this.onEnd)
    output.on('close', this.onEnd)
    output.on('error', this.onError)
    if (input.destroyed || input.readableEnded || output.destroyed || !output.writable) {
      this.onEnd()
    }
  }

  get closed(): boolean {
    return this.closing || this.terminalError !== undefined
  }

  /** A process exit can precede the last bytes already written to stdout. */
  beginInputCompletion(error: Error): void {
    this.inputEndError ??= error
    this.output.removeListener('finish', this.onEnd)
    this.output.removeListener('close', this.onEnd)
    this.writer.close(error)
  }

  finishOnInputEnd(error: Error): Promise<void> {
    this.beginInputCompletion(error)
    return this.source.finish()
  }

  pauseReading(): void {
    if (this.source.ending) {
      return
    }
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
    options: JsonlRpcRequestOptions = {}
  ): Promise<unknown> {
    if (this.closed || this.inputEndError) {
      return Promise.reject(
        this.terminalError ?? this.inputEndError ?? new Error('Agent JSON-lines RPC stream closed')
      )
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
    if (options.oversizedReply === 'reject' && this.nextOptionalId >= Number.MAX_SAFE_INTEGER) {
      return Promise.reject(new Error('JSON-lines RPC optional request identity exhausted'))
    }
    const id =
      options.oversizedReply === 'reject'
        ? `orca-optional-${++this.nextOptionalId}`
        : `orca-${++this.nextId}`
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
          if (!this.inputEndError) {
            this.rejectPending(id, error instanceof Error ? error : new Error(String(error)))
          }
        }
      )
    })
  }

  /** The dialect may track acknowledgements independently of transport correlation. */
  send(record: JsonlRpcRecord, signal?: AbortSignal): Promise<void> {
    if (this.closed || this.inputEndError) {
      return Promise.reject(
        this.terminalError ?? this.inputEndError ?? new Error('Agent JSON-lines RPC stream closed')
      )
    }
    try {
      return this.writer.write(encodeNdjson(record, this.limits.maxLineBytes), signal)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  close(error: Error = new Error('Agent JSON-lines RPC stream closed')): void {
    if (this.closed) {
      return
    }
    this.source?.dispose()
    // Transfer the retained complete tail before close observers retire its timeline lane.
    try {
      this.framer.drain()
    } catch (cause) {
      error = cause instanceof Error ? cause : new Error(String(cause))
    }
    this.closing = true
    this.terminalError = error
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
    if (this.terminalError) {
      return
    }
    dispatchJsonlRpcRecord(
      value,
      this.pending,
      (id, error) => this.rejectPending(id, error),
      this.handlers.onRecord,
      (message) => this.diagnose(message)
    )
  }
}
