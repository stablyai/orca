import type { Readable, Writable } from 'node:stream'

const DEFAULT_MAX_FRAME_BYTES = 64 * 1024
const DEFAULT_MAX_QUEUE_BYTES = 1024 * 1024
const DEFAULT_MAX_PENDING_OUTPUT_BYTES = 8 * 1024 * 1024

export type TerminalBridgeNdjsonReaderOptions = {
  input: Readable
  onLine: (line: string) => Promise<void> | void
  onEnd: () => void
  onError: (error: Error) => void
  maxFrameBytes?: number
  maxQueueBytes?: number
}

export class TerminalBridgeNdjsonReader {
  private readonly input: Readable
  private readonly onLine: (line: string) => Promise<void> | void
  private readonly onEnd: () => void
  private readonly onError: (error: Error) => void
  private readonly maxFrameBytes: number
  private readonly maxQueueBytes: number
  private buffer = ''
  private bufferBytes = 0
  private queue: { line: string; bytes: number }[] = []
  private queueBytes = 0
  private draining = false
  private ended = false
  private stopped = false

  constructor(options: TerminalBridgeNdjsonReaderOptions) {
    this.input = options.input
    this.onLine = options.onLine
    this.onEnd = options.onEnd
    this.onError = options.onError
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
    this.maxQueueBytes = options.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES
    this.input.setEncoding('utf8')
    this.input.on('data', this.handleData)
    this.input.once('end', this.handleEnd)
    this.input.once('error', this.handleError)
  }

  close(): void {
    if (this.stopped) {
      return
    }
    this.stopped = true
    this.input.pause()
    this.input.off('data', this.handleData)
    this.input.off('end', this.handleEnd)
    this.input.off('error', this.handleError)
    this.queue = []
    this.queueBytes = 0
    this.buffer = ''
    this.bufferBytes = 0
  }

  private readonly handleData = (chunk: string): void => {
    let start = 0
    while (!this.stopped) {
      const newline = chunk.indexOf('\n', start)
      if (newline === -1) {
        this.append(chunk.slice(start))
        return
      }
      if (!this.append(chunk.slice(start, newline))) {
        return
      }
      this.enqueueBuffer()
      start = newline + 1
    }
  }

  private readonly handleEnd = (): void => {
    if (this.stopped) {
      return
    }
    this.ended = true
    if (this.buffer) {
      this.enqueueBuffer()
    }
    this.drain()
  }

  private readonly handleError = (error: Error): void => {
    this.fail(error)
  }

  private append(value: string): boolean {
    if (!value) {
      return true
    }
    const bytes = Buffer.byteLength(value)
    if (this.bufferBytes + bytes > this.maxFrameBytes) {
      this.fail(new Error('Terminal bridge input frame exceeds the maximum size.'))
      return false
    }
    this.buffer += value
    this.bufferBytes += bytes
    return true
  }

  private enqueueBuffer(): void {
    const line = this.buffer
    const bytes = this.bufferBytes
    this.buffer = ''
    this.bufferBytes = 0
    if (!line.trim()) {
      return
    }
    if (this.queueBytes + bytes > this.maxQueueBytes) {
      this.fail(new Error('Terminal bridge input queue exceeded its byte limit.'))
      return
    }
    this.queue.push({ line, bytes })
    this.queueBytes += bytes
    this.drain()
  }

  private drain(): void {
    if (this.draining || this.stopped) {
      return
    }
    const next = this.queue.shift()
    if (!next) {
      if (this.ended) {
        this.onEnd()
      } else {
        this.input.resume()
      }
      return
    }
    this.draining = true
    this.input.pause()
    this.queueBytes -= next.bytes
    Promise.resolve(this.onLine(next.line)).then(
      () => {
        this.draining = false
        this.drain()
      },
      (error: unknown) => {
        this.draining = false
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    )
  }

  private fail(error: Error): void {
    if (this.stopped) {
      return
    }
    this.close()
    this.onError(error)
  }
}

export type TerminalBridgeNdjsonWriterOptions = {
  output: Writable
  onError: (error: Error) => void
  maxPendingBytes?: number
}

export class TerminalBridgeNdjsonWriter {
  private readonly output: Writable
  private readonly onError: (error: Error) => void
  private readonly maxPendingBytes: number
  private queue: { frame: string; bytes: number }[] = []
  private queueBytes = 0
  private blocked = false
  private failed = false
  private finishing = false
  private pendingWrites = 0
  private finishPromise: Promise<void> | null = null
  private resolveFinish: (() => void) | null = null

  constructor(options: TerminalBridgeNdjsonWriterOptions) {
    this.output = options.output
    this.onError = options.onError
    this.maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_OUTPUT_BYTES
    this.output.once('error', this.handleError)
  }

  write(event: unknown): boolean {
    if (this.failed || this.finishing) {
      return false
    }
    const frame = `${JSON.stringify(event)}\n`
    const bytes = Buffer.byteLength(frame)
    if (this.pendingBytes() + bytes > this.maxPendingBytes) {
      this.fail(new Error('Terminal bridge output exceeded its backpressure limit.'))
      return false
    }
    if (this.blocked) {
      this.queue.push({ frame, bytes })
      this.queueBytes += bytes
      return true
    }
    this.writeFrame(frame)
    return true
  }

  finish(): Promise<void> {
    if (this.failed) {
      return Promise.resolve()
    }
    if (this.finishPromise) {
      return this.finishPromise
    }
    this.finishing = true
    this.finishPromise = new Promise<void>((resolve) => {
      this.resolveFinish = resolve
    })
    this.settleFinish()
    return this.finishPromise
  }

  abort(): void {
    this.failed = true
    this.output.off('error', this.handleError)
    this.output.off('drain', this.handleDrain)
    this.queue = []
    this.queueBytes = 0
    this.resolveFinish?.()
    this.resolveFinish = null
  }

  private pendingBytes(): number {
    return this.output.writableLength + this.queueBytes
  }

  private writeFrame(frame: string): void {
    this.pendingWrites += 1
    this.blocked = !this.output.write(frame, (error) => {
      this.pendingWrites -= 1
      if (error) {
        this.fail(error)
        return
      }
      this.settleFinish()
    })
    if (this.blocked) {
      this.output.once('drain', this.handleDrain)
    }
  }

  private readonly handleDrain = (): void => {
    if (this.failed) {
      return
    }
    this.blocked = false
    while (!this.blocked && this.queue.length > 0) {
      const next = this.queue.shift()!
      this.queueBytes -= next.bytes
      this.writeFrame(next.frame)
    }
    this.settleFinish()
  }

  private settleFinish(): void {
    if (
      !this.finishing ||
      this.failed ||
      this.blocked ||
      this.queue.length > 0 ||
      this.pendingWrites > 0
    ) {
      return
    }
    this.output.off('error', this.handleError)
    this.output.off('drain', this.handleDrain)
    this.resolveFinish?.()
    this.resolveFinish = null
  }

  private readonly handleError = (error: Error): void => {
    this.fail(error)
  }

  private fail(error: Error): void {
    if (this.failed) {
      return
    }
    this.abort()
    this.onError(error)
  }
}
