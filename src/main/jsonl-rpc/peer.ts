import type { Readable, Writable } from 'node:stream'
import { z } from 'zod'
import {
  createIncrementalNdjsonFramer,
  encodeNdjson
} from '../../shared/main-process-ndjson-framer'
import { detachProviderStreamErrorHandler } from '../provider-process/provider-stdio-error-boundary'
import { ProviderStdioWriteQueue } from '../provider-process/provider-stdio-write-queue'
import { ProviderOutputEnd } from '../provider-process/provider-output-end'
import {
  jsonlRpcRequestTimeout,
  resolveJsonlRpcPeerOptions,
  type JsonlRpcPeerOptions
} from './peer-limits'
import { settleOversizedJsonlRecord, type JsonlRpcRequestOptions } from './peer-oversized-record'
import { settleJsonlRpcReply, type JsonlRpcPendingRequest } from './peer-reply'

const recordSchema = z.looseObject({ type: z.string() })

export type JsonlRpcRecord = z.infer<typeof recordSchema>
export class JsonlRpcStreamClosedError extends Error {
  constructor() {
    super('Agent JSON-lines RPC stream closed')
    this.name = 'JsonlRpcStreamClosedError'
  }
}
export { JsonlRpcResponseError } from './peer-reply'
export type JsonlRpcPeerHandlers = {
  /** Includes id-less deferred prompt acknowledgements; dialect failures are fatal to preserve lifecycle evidence. */
  onRecord?: (record: JsonlRpcRecord) => void
  /** An event over the line limit was dropped, leaving only its bounded prefix; the stream stays open. */
  onOversizedEvent?: (type: string, prefix: string) => void
  onClose?: (error: Error) => void
  onDiagnostic?: (message: string) => void
  /** Holds the close at the end of the agent's output, as for its exit report; `finish` closes. */
  onInputEnd?: (finish: () => void) => void
}

/** Transport only: a dialect owns turns, dialogs, and session handles. */
export class JsonlRpcPeer {
  private readonly limits: Required<JsonlRpcPeerOptions>
  private readonly pending = new Map<string, JsonlRpcPendingRequest>()
  private readonly writer: ProviderStdioWriteQueue
  private readonly framer: ReturnType<typeof createIncrementalNdjsonFramer>
  private nextId = 0
  private nextOptionalId = 0
  private terminalError?: Error
  private inputEndError?: Error
  private readonly outputEnd: ProviderOutputEnd
  private readingPaused = false

  constructor(
    private readonly input: Readable,
    output: Writable,
    private readonly handlers: JsonlRpcPeerHandlers = {},
    options: JsonlRpcPeerOptions = {}
  ) {
    this.limits = resolveJsonlRpcPeerOptions(options)
    this.writer = new ProviderStdioWriteQueue(
      output,
      this.limits.maxQueuedWriteBytes,
      (error) => this.endOutput(error),
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
    input.setEncoding('utf8')
    input.on('data', this.onData)
    input.on('end', this.onEnd)
    input.on('close', this.onEnd)
    input.on('error', this.onError)
    this.outputEnd = new ProviderOutputEnd(
      output,
      (error) => this.endOutput(error),
      () => this.inputEndError ?? new JsonlRpcStreamClosedError()
    )
    if (input.destroyed || input.readableEnded) {
      this.onEnd()
    } else if (output.destroyed || !output.writable) {
      this.endOutput(new JsonlRpcStreamClosedError())
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
    options: JsonlRpcRequestOptions = {}
  ): Promise<unknown> {
    if (this.terminalError ?? this.outputEnd.error) {
      return Promise.reject(this.terminalError ?? this.outputEnd.error)
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
          // A write lost to the agent no longer reading leaves the call to the output drain.
          if (!this.outputEnd.error) {
            this.rejectPending(id, error instanceof Error ? error : new Error(String(error)))
          }
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
    this.outputEnd.detach()
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
  private readonly onEnd = (): void => {
    const finish = (): void =>
      this.close(this.inputEndError ?? this.outputEnd.error ?? new JsonlRpcStreamClosedError())
    if (this.inputEndError || !this.handlers.onInputEnd) {
      finish()
    } else {
      this.handlers.onInputEnd(finish)
    }
  }

  private endOutput(error: Error): void {
    if (this.terminalError || !this.outputEnd.begin(error)) {
      return
    }
    this.writer.close(error)
    this.outputEnd.settle(this.pending.size > 0, this.input, () =>
      this.close(this.inputEndError ?? error)
    )
  }
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
    if (settleJsonlRpcReply(record, this.pending, (id, error) => this.rejectPending(id, error))) {
      if (this.outputEnd.error && this.pending.size === 0) {
        this.close(this.inputEndError ?? this.outputEnd.error)
      }
      return
    }
    this.handlers.onRecord?.(record)
  }
}
