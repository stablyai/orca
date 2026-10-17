import {
  childProcessHasExited,
  signalProcessTree
} from '@orca/process-host/process-tree-termination'
import { terminateWindowsProcessTree } from '../windows-process-tree-kill'
import { readDapMessage, type Event, type Request, type Response } from './dap-protocol'
import type { DapTransport } from './dap-transport'

export class DapConnectionClosedError extends Error {}
export class DapRequestTimeoutError extends Error {}
/** The adapter answered `success: false`; a refusal is an error, never an empty result. */
export class DapResponseError extends Error {
  constructor(readonly response: Response) {
    super(`${response.command} failed: ${response.message ?? 'no message'}`)
  }
}

// Capped: a broken or hostile adapter must not grow main's read buffer without bound.
export const DAP_MAX_MESSAGE_BYTES = 64 * 1024 * 1024
export const DAP_MAX_HEADER_BYTES = 8 * 1024
export const DAP_DEFAULT_REQUEST_TIMEOUT_MS = 30_000
export const DAP_DEFAULT_CLOSE_TIMEOUT_MS = 2_000

/** Answers an adapter's reverse request; the return value is the response body, a throw refuses it. */
export type DapReverseRequestHandler = (request: Request) => unknown

export type DapConnectionOptions = {
  requestTimeoutMs?: number
  closeTimeoutMs?: number
  onReverseRequest?: DapReverseRequestHandler
}

type Pending = {
  resolve: (response: Response) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Runs a listener so a throw is logged instead of escaping an EventEmitter callback in main. */
function guarded(kind: string, run: () => void): void {
  try {
    run()
  } catch (error) {
    console.warn(`[dap] ${kind} listener threw`, error)
  }
}

/** One DAP session over a transport; the adapter process (if any) dies with it. */
export class DapConnection {
  private readonly pending = new Map<number, Pending>()
  private readonly eventListeners = new Set<(event: Event) => void>()
  private readonly closeListeners = new Set<(reason: string) => void>()
  private nextSeq = 1
  // Why chunks: re-concatenating per chunk is quadratic on a 64 MiB frame and stalls main.
  private chunks: Buffer[] = []
  private buffered = 0
  /** Bytes the frame being read needs; nothing is copied until they have arrived. */
  private needed = 0
  private reason: string | null = null
  private shutdown: Promise<void> | null = null

  constructor(
    private readonly transport: DapTransport,
    private readonly options: DapConnectionOptions = {}
  ) {
    const { input, output, child } = transport
    input.on('data', (chunk: Buffer) => this.onData(chunk))
    input.on('error', (error) => this.fail(`read failed: ${error.message}`))
    input.on('close', () => {
      // A stdio adapter's stdout closes just before 'exit', which carries the code and stderr tail.
      if (!(transport.kind === 'stdio' && child)) {
        this.fail('adapter closed the connection')
      }
    })
    output.on('error', (error) => this.fail(`write failed: ${error.message}`))
    child?.on('error', (error) => this.fail(`adapter failed to start: ${error.message}`))
    child?.on('exit', (code, signal) => this.fail(`adapter exited with ${signal ?? code}`))
  }

  get closed(): boolean {
    return this.reason !== null
  }

  get closeReason(): string | null {
    return this.reason
  }

  /** The last 64 KiB the adapter wrote to stderr. */
  get stderr(): string {
    return this.transport.stderr.text()
  }

  /** Resolves with the matching response (keyed on `request_seq`, never `seq`). */
  request(
    command: string,
    args?: unknown,
    options: { timeoutMs?: number } = {}
  ): Promise<Response> {
    if (this.reason !== null) {
      return Promise.reject(new DapConnectionClosedError(`DAP connection closed: ${this.reason}`))
    }
    const seq = this.nextSeq++
    const timeoutMs =
      options.timeoutMs ?? this.options.requestTimeoutMs ?? DAP_DEFAULT_REQUEST_TIMEOUT_MS
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        reject(new DapRequestTimeoutError(`${command} got no response in ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(seq, { resolve, reject, timer })
      this.write({
        seq,
        type: 'request',
        command,
        ...(args === undefined ? {} : { arguments: args })
      })
    })
  }

  onEvent(listener: (event: Event) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  /** Called once with the reason; immediately (next tick) if already closed. */
  onClose(listener: (reason: string) => void): () => void {
    if (this.reason !== null) {
      const reason = this.reason
      queueMicrotask(() => guarded('close', () => listener(reason)))
      return () => {}
    }
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  /** Bounded: never waits on the stderr pipe, which an adapter's grandchildren inherit. */
  close(reason = 'closed by client'): Promise<void> {
    this.fail(reason)
    return this.shutdown ?? Promise.resolve()
  }

  /** SIGKILLs the adapter's process group now, for app quit where nothing async gets to run. */
  killSync(): void {
    const { child } = this.transport
    if (!child?.pid || childProcessHasExited(child)) {
      this.transport.dispose?.()
      return
    }
    try {
      if (process.platform === 'win32') {
        // taskkill is launched before this returns; quit does not wait for its exit.
        void terminateWindowsProcessTree(child.pid, { site: 'debug-adapter-quit' })
      } else {
        process.kill(-child.pid, 'SIGKILL')
      }
    } catch {
      child.kill('SIGKILL')
    }
    // Quit runs nothing after this, so the socket directory goes now too.
    this.transport.dispose?.()
  }

  private write(message: Record<string, unknown>): void {
    if (this.reason !== null || this.transport.output.destroyed) {
      return
    }
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    this.transport.output.write(
      Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
    )
  }

  private onData(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.buffered += chunk.length
    if (this.reason !== null || this.buffered < this.needed) {
      return
    }
    let buffer = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks)
    this.needed = 0
    while (this.reason === null) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1 || headerEnd > DAP_MAX_HEADER_BYTES) {
        if (headerEnd !== -1 || buffer.length > DAP_MAX_HEADER_BYTES) {
          this.fail('adapter sent a header longer than 8 KiB')
        }
        break
      }
      const header = buffer.subarray(0, headerEnd).toString('ascii')
      const length = Number(/Content-Length: *(\d+)/i.exec(header)?.[1] ?? Number.NaN)
      const bodyStart = headerEnd + 4
      if (!Number.isSafeInteger(length) || length > DAP_MAX_MESSAGE_BYTES) {
        const what = Number.isNaN(length) ? 'no Content-Length' : `Content-Length ${length}`
        this.fail(`adapter sent a header with ${what}`)
        break
      }
      if (buffer.length < bodyStart + length) {
        this.needed = bodyStart + length
        break
      }
      const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
      buffer = buffer.subarray(bodyStart + length)
      let message: unknown
      try {
        message = JSON.parse(body)
      } catch {
        this.fail('adapter sent a frame that is not JSON')
        break
      }
      this.onMessage(message)
    }
    this.chunks = this.reason === null && buffer.length > 0 ? [buffer] : []
    this.buffered = this.chunks[0]?.length ?? 0
  }

  private onMessage(value: unknown): void {
    const message = readDapMessage(value)
    if ('invalid' in message) {
      this.fail(`adapter sent ${message.invalid}`)
      return
    }
    if (message.type === 'response') {
      const entry = this.pending.get(message.request_seq)
      if (!entry) {
        return
      }
      this.pending.delete(message.request_seq)
      clearTimeout(entry.timer)
      if (message.success) {
        entry.resolve(message)
      } else {
        entry.reject(new DapResponseError(message))
      }
    } else if (message.type === 'event') {
      for (const listener of this.eventListeners) {
        // Why: a throw here escapes the transport's 'data' callback as an uncaught exception in main.
        guarded('event', () => listener(message))
      }
    } else {
      void this.answerReverseRequest(message)
    }
  }

  /** A reverse request blocks the adapter until answered, so even a refusal must be sent. */
  private async answerReverseRequest(request: Request): Promise<void> {
    const reply = (success: boolean, extra: { body?: unknown; message?: string }): void =>
      this.write({
        seq: this.nextSeq++,
        type: 'response',
        request_seq: request.seq,
        command: request.command,
        success,
        ...extra
      })
    const handler = this.options.onReverseRequest
    if (!handler) {
      reply(false, { message: 'not supported' })
      return
    }
    try {
      const body = await handler(request)
      reply(true, body === undefined ? {} : { body })
    } catch (error) {
      reply(false, {
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private fail(reason: string): void {
    if (this.reason !== null) {
      return
    }
    const tail = this.transport.stderr.text().trim().slice(-1024)
    this.reason = reason.startsWith('adapter exited') && tail ? `${reason}: ${tail}` : reason
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new DapConnectionClosedError(`DAP connection closed: ${this.reason}`))
    }
    this.pending.clear()
    this.chunks = []
    this.buffered = 0
    this.shutdown = this.shutdownTransport()
    const closed = this.reason
    for (const listener of this.closeListeners) {
      guarded('close', () => listener(closed))
    }
    this.closeListeners.clear()
  }

  private async shutdownTransport(): Promise<void> {
    const { child, socket } = this.transport
    socket?.destroy()
    if (!child) {
      this.transport.dispose?.()
      return
    }
    if (!childProcessHasExited(child)) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      await signalProcessTree(child, 'SIGTERM')
      const timeoutMs = this.options.closeTimeoutMs ?? DAP_DEFAULT_CLOSE_TIMEOUT_MS
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        exited,
        new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs)))
      ])
      clearTimeout(timer)
    }
    // Why always: a debuggee grandchild outlives a root that exited on SIGTERM.
    await signalProcessTree(child, 'SIGKILL')
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
    this.transport.dispose?.()
  }
}
