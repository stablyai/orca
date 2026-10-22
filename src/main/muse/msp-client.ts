// A Muse Session Protocol client over a `muse serve` stdio child: NDJSON
// JSON-RPC with UUIDv7 command ids, server notifications as events, and the two
// server-initiated requests (approval, user input) answered through handlers.

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type {
  MspApprovalRequest,
  MspClientInfo,
  MspInitializeResult,
  MspUserInputRequest
} from './msp-protocol'
import { isRecord } from './msp-protocol'

export type MspSpawn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => ChildProcess

export type MspRequestError = {
  code: number
  message: string
  data?: unknown
}

export class MspError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(`${method} failed: ${message}`)
    this.name = 'MspError'
  }
}

/** UUIDv7, as MSP command ids require; no dependency for one call site. */
export function mintMspCommandId(): string {
  const bytes = randomBytes(16)
  const millis = Date.now()
  bytes[0] = (millis / 2 ** 40) % 256
  bytes[1] = (millis / 2 ** 32) % 256
  bytes[2] = (millis / 2 ** 24) % 256
  bytes[3] = (millis / 2 ** 16) % 256
  bytes[4] = (millis / 2 ** 8) % 256
  bytes[5] = millis % 256
  bytes[6] = 0x70 | (bytes[6] & 0x0f)
  bytes[8] = 0x80 | (bytes[8] & 0x3f)
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  method: string
}

export type MspServerRequestHandler = (
  method: string,
  params: Record<string, unknown>
) => Promise<unknown>

export type MspNotificationHandler = (method: string, params: unknown) => void

const MAX_LINE_BYTES = 256 * 1024 * 1024

export class MspClient {
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private buffer = ''
  private closedError: Error | null = null
  private readonly exitListeners = new Set<(error: Error | null) => void>()
  readonly exited: Promise<Error | null>

  constructor(
    private readonly child: ChildProcess,
    private onRequest: MspServerRequestHandler = async () => {
      throw new Error('no MSP server-request handler')
    },
    private onNotification: MspNotificationHandler = () => undefined
  ) {
    this.exited = new Promise<Error | null>((resolve) => {
      this.exitListeners.add(resolve)
    })
    this.child.stdout?.on('data', (chunk: Buffer) => this.read(chunk))
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTailSource += chunk.toString('utf8')
    })
    const fail = (error: Error): void => this.fail(error)
    this.child.on('error', fail)
    this.child.on('exit', (code, signal) => {
      const tail = this.stderrTail.trim()
      fail(
        new Error(
          `muse serve exited${code !== null ? ` with code ${code}` : ''}${signal ? ` on ${signal}` : ''}${tail ? `: ${tail}` : ''}`
        )
      )
    })
  }

  private stderrTailSource = ''
  private get stderrTail(): string {
    return this.stderrTailSource.slice(-4000)
  }

  private read(chunk: Buffer): void {
    if (this.closedError) {
      return
    }
    this.buffer += chunk.toString('utf8')
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.length > 0) {
        this.readLine(line)
      }
      index = this.buffer.indexOf('\n')
    }
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.fail(new Error('muse serve sent a line past the protocol limit'))
    }
  }

  private readLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.fail(new Error(`muse serve sent malformed JSON: ${line.slice(0, 200)}`))
      return
    }
    if (!isRecord(message)) {
      return
    }
    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (!pending) {
        return
      }
      if (isRecord(message.error)) {
        const code = typeof message.error.code === 'number' ? message.error.code : -32000
        const text = typeof message.error.message === 'string' ? message.error.message : 'error'
        pending.reject(new MspError(pending.method, code, text, message.error.data))
        return
      }
      pending.resolve(message.result)
      return
    }
    if (typeof message.method !== 'string') {
      return
    }
    const params = isRecord(message.params) ? message.params : {}
    if (message.id !== undefined) {
      const id = message.id
      void this.onRequest(message.method, params).then(
        (result) => this.write({ jsonrpc: '2.0', id, result: result ?? null }),
        (error: unknown) =>
          this.write({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : String(error)
            }
          })
      )
      return
    }
    try {
      this.onNotification(message.method, message.params ?? null)
    } catch {
      // A notification listener never breaks the pump.
    }
  }

  private write(message: unknown): void {
    if (this.closedError || !this.child.stdin?.writable) {
      return
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private fail(error: Error): void {
    if (this.closedError) {
      return
    }
    this.closedError = error
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
    for (const listener of this.exitListeners) {
      listener(error)
    }
    this.exitListeners.clear()
  }

  request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.closedError) {
      return Promise.reject(this.closedError)
    }
    const id = this.nextId
    this.nextId += 1
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject
      })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  setRequestHandler(handler: MspServerRequestHandler): void {
    this.onRequest = handler
  }

  setNotificationHandler(handler: MspNotificationHandler): void {
    this.onNotification = handler
  }

  async close(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return
    }
    this.child.kill(signal)
    await this.exited
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  get alive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null
  }
}

export type MspSpawnOptions = {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  spawnImpl?: MspSpawn
  onRequest?: MspServerRequestHandler
  onNotification?: MspNotificationHandler
}

export function spawnMspClient(options: MspSpawnOptions): MspClient {
  const spawnImpl: MspSpawn =
    options.spawnImpl ??
    ((command, args, spawnOptions) =>
      spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'], ...spawnOptions }))
  const child = spawnImpl(options.command, options.args, { cwd: options.cwd, env: options.env })
  return new MspClient(child, options.onRequest, options.onNotification)
}

export async function initializeMspClient(
  client: MspClient,
  clientInfo: MspClientInfo
): Promise<MspInitializeResult> {
  const result = await client.request<MspInitializeResult>('initialize', { clientInfo })
  client.notify('initialized', {})
  return result
}

export type MspApprovalHandler = (request: MspApprovalRequest) => Promise<{
  choiceId: string
  feedback?: string
}>

export type MspUserInputHandler = (request: MspUserInputRequest) => Promise<{
  answers: { questionId: string; selectedLabel?: string; selectedLabels?: string[] }[]
}>
