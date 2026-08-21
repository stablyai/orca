import { StringDecoder } from 'node:string_decoder'
import {
  asJsonRecord,
  isAppServerRequestId,
  parseInitializeResult,
  type CodexAppServerInitializeResult,
  type CodexAppServerRequest,
  type CodexAppServerRequestId
} from './codex-app-server-protocol'
import type {
  CodexAppServerProcess,
  CodexAppServerProcessFactory
} from './codex-app-server-process'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_STDERR_TAIL = 8_192

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type CodexAppServerNotification = { method: string; params: unknown }

export type CodexAppServerConnection = {
  readonly initializeResult: CodexAppServerInitializeResult
  request: (method: string, params?: unknown) => Promise<unknown>
  respond: (id: CodexAppServerRequestId, result: unknown) => void
  respondError: (id: CodexAppServerRequestId, code: number, message: string) => void
  onNotification: (listener: (event: CodexAppServerNotification) => void) => () => void
  onServerRequest: (listener: (request: CodexAppServerRequest) => void) => () => void
  onClose: (listener: (error: Error) => void) => () => void
  dispose: () => void
}

export async function connectCodexAppServer(args: {
  processFactory: CodexAppServerProcessFactory
  requestTimeoutMs?: number
}): Promise<CodexAppServerConnection> {
  const client = new CodexAppServerJsonlClient(
    args.processFactory(),
    args.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  )
  try {
    return await client.initialize()
  } catch (error) {
    client.dispose()
    throw error
  }
}

class CodexAppServerJsonlClient implements CodexAppServerConnection {
  initializeResult!: CodexAppServerInitializeResult

  private readonly pending = new Map<CodexAppServerRequestId, PendingRequest>()
  private readonly notificationListeners = new Set<(event: CodexAppServerNotification) => void>()
  private readonly requestListeners = new Set<(request: CodexAppServerRequest) => void>()
  private readonly closeListeners = new Set<(error: Error) => void>()
  private readonly decoder = new StringDecoder('utf8')
  private nextRequestId = 1
  private buffer = ''
  private stderrTail = ''
  private closedError: Error | null = null

  constructor(
    private readonly process: CodexAppServerProcess,
    private readonly requestTimeoutMs: number
  ) {
    process.stdout?.on('data', this.handleStdoutData)
    process.stderr?.on('data', this.handleStderrData)
    process.once('error', this.handleProcessError)
    process.once('close', this.handleProcessClose)
  }

  async initialize(): Promise<this> {
    // Why: match the current main handshake so a Side Quest process is not a
    // second, older client identity on the same Codex app-server protocol.
    const result = await this.request('initialize', {
      clientInfo: { name: 'orca_desktop', title: 'Orca', version: '0.0.0' }
    })
    this.initializeResult = parseInitializeResult(result)
    this.write({ method: 'initialized' })
    return this
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.closedError) {
      return Promise.reject(this.closedError)
    }
    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const error = new Error(`Codex app-server request "${method}" timed out.`)
        reject(error)
        // Why: a timed-out JSONL request leaves request ordering unknowable;
        // terminate the channel so the manager can start a clean server.
        this.fail(error)
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.write({ method, id, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  respond(id: CodexAppServerRequestId, result: unknown): void {
    this.write({ id, result })
  }

  respondError(id: CodexAppServerRequestId, code: number, message: string): void {
    this.write({ id, error: { code, message } })
  }

  onNotification(listener: (event: CodexAppServerNotification) => void): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  onServerRequest(listener: (request: CodexAppServerRequest) => void): () => void {
    this.requestListeners.add(listener)
    return () => this.requestListeners.delete(listener)
  }

  onClose(listener: (error: Error) => void): () => void {
    if (this.closedError) {
      listener(this.closedError)
      return () => {}
    }
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  dispose(): void {
    if (!this.closedError) {
      this.fail(new Error('Codex app-server connection was closed.'))
    }
    this.detachProcessListeners()
    try {
      this.process.kill()
    } catch {
      // The process may have exited between the connection failure and cleanup.
    }
  }

  private readonly handleStdoutData = (chunk: Buffer | string): void => {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (line.trim()) {
        this.handleLine(line)
      }
      newline = this.buffer.indexOf('\n')
    }
  }

  private readonly handleStderrData = (chunk: Buffer | string): void => {
    this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-MAX_STDERR_TAIL)
  }

  private readonly handleProcessError = (error: Error): void => this.fail(error)

  private readonly handleProcessClose = (code: number | null): void => {
    const detail = this.stderrTail.trim()
    const suffix = detail ? `: ${detail}` : ''
    this.fail(
      new Error(`Codex app-server exited${code === null ? '' : ` with code ${code}`}${suffix}`)
    )
  }

  private handleLine(line: string): void {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      this.fail(new Error('Codex app-server emitted invalid JSON.'))
      return
    }
    const message = asJsonRecord(value)
    if (!message) {
      this.fail(new Error('Codex app-server emitted an invalid protocol message.'))
      return
    }
    if (isAppServerRequestId(message.id) && ('result' in message || 'error' in message)) {
      this.handleResponse(message.id, message)
      return
    }
    if (typeof message.method !== 'string') {
      return
    }
    if (isAppServerRequestId(message.id)) {
      const request = { id: message.id, method: message.method, params: message.params }
      for (const listener of this.requestListeners) {
        listener(request)
      }
      return
    }
    const notification = { method: message.method, params: message.params }
    for (const listener of this.notificationListeners) {
      listener(notification)
    }
  }

  private handleResponse(id: CodexAppServerRequestId, message: Record<string, unknown>): void {
    const pending = this.pending.get(id)
    if (!pending) {
      return
    }
    clearTimeout(pending.timer)
    this.pending.delete(id)
    const error = asJsonRecord(message.error)
    if (error) {
      const detail = typeof error.message === 'string' ? error.message : 'Unknown app-server error.'
      pending.reject(new Error(detail))
      return
    }
    pending.resolve(message.result)
  }

  private write(message: unknown): void {
    if (this.closedError) {
      throw this.closedError
    }
    if (!this.process.stdin) {
      throw new Error('Codex app-server stdin is unavailable.')
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private fail(error: Error): void {
    if (this.closedError) {
      return
    }
    this.closedError = error
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
    for (const listener of this.closeListeners) {
      listener(error)
    }
    this.closeListeners.clear()
    this.detachProcessListeners()
    try {
      this.process.kill()
    } catch {
      // Best-effort: malformed output must not leave an unowned server alive.
    }
  }

  private detachProcessListeners(): void {
    this.process.stdout?.off('data', this.handleStdoutData)
    this.process.stderr?.off('data', this.handleStderrData)
    this.process.off('error', this.handleProcessError)
    this.process.off('close', this.handleProcessClose)
  }
}
