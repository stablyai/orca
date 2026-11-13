import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { spawnManagedProviderProcess } from '../provider-process/managed-provider-process'
import { createClaudeChildTreeReaper } from '../claude/claude-agent-sdk-exit-proof'
import { createProviderRecordReader } from '../provider-process/provider-record-reader'
import { afterProviderOutputDrains } from '../provider-process/provider-exit-output-drain'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import type { ProviderProcessCloseResult } from '../provider-process/provider-process-close'
import { withProviderRequestTimeout } from '../provider-process/provider-request-timeout'
import { withProviderSpawnAbsence } from '../provider-process/provider-executable-missing'
import { traexRecord, TraexRequestError } from './traex-protocol'

export type TraexServerRequest = {
  id: number | string
  method: string
  params: unknown
}

export type TraexConnectionHandlers = {
  onNotification?: (method: string, params: unknown) => void
  onRequest?: (request: TraexServerRequest) => void
  onExit?: (error: Error, expected: boolean) => void
  onProtocolFailure?: (error: Error) => void
}

type PendingRequest = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
  onReply?: (value: unknown) => void
}

export class TraexAppServerConnection {
  private readonly managed
  private readonly tree
  private readonly reader
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private closing = false
  private failure: Error | null = null
  private reportedExit = false
  private readonly exitListeners = new Set<() => void>()
  private readonly outputDrained = Promise.withResolvers<void>()

  constructor(
    launch: ProviderProcessLaunch,
    private readonly handlers: TraexConnectionHandlers = {},
    spawnImpl?: PipedProcessSpawner
  ) {
    this.managed = spawnManagedProviderProcess(launch, {
      site: 'traex-app-server-teardown',
      ...(spawnImpl ? { spawnImpl } : {})
    })
    const { child } = this.managed
    this.tree = createClaudeChildTreeReaper(child, {
      site: 'traex-app-server-child-close',
      exited: () => this.managed.rootVerdict === 'exited',
      supervised: this.managed.supervised
    })
    this.reader = createProviderRecordReader({
      stdout: child.stdout,
      onRecord: (value) => this.receive(value),
      onRejected: () => this.failProtocol(new Error('TRAE CLI emitted invalid JSON')),
      onFatal: (error) => this.failProtocol(error)
    })
    child.stdin.on('error', (error) => this.failProtocol(error))
    child.on('error', (error) => this.failPending(error))
    this.managed.onExit(() => {
      const error = withProviderSpawnAbsence(
        this.failure ?? new Error(this.managed.stderrTail().trim() || 'TRAE CLI exited'),
        this.managed.spawnAbsence
      )
      afterProviderOutputDrains(
        child.stdout,
        () => {
          this.failPending(error)
          if (!this.reportedExit) {
            this.reportedExit = true
            try {
              this.handlers.onExit?.(error, this.closing)
              for (const listener of this.exitListeners) {
                listener()
              }
            } finally {
              this.exitListeners.clear()
              this.outputDrained.resolve()
            }
          }
        },
        child
      )
    })
  }

  get pid(): number | undefined {
    return this.managed.child.pid
  }

  get closed(): boolean {
    return this.closing || this.failure !== null || this.managed.rootVerdict === 'exited'
  }

  get closeResult(): ProviderProcessCloseResult | null {
    return this.managed.lastCloseResult
  }

  get lastCloseResult(): ProviderProcessCloseResult | null {
    return this.closeResult
  }

  onExit(listener: () => void): void {
    if (this.reportedExit) {
      listener()
    } else {
      this.exitListeners.add(listener)
    }
  }

  get exited(): boolean {
    return this.managed.rootVerdict === 'exited'
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number | null; onReply?: (value: unknown) => void } = {}
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(this.failure ?? new Error('TRAE CLI connection is closed'))
    }
    if (this.pending.size >= 128) {
      return Promise.reject(new Error('TRAE CLI pending request capacity exceeded'))
    }
    const id = this.nextId++
    const timeoutMs = options.timeoutMs === undefined ? 30_000 : options.timeoutMs
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id)
              reject(
                withProviderRequestTimeout(new Error(`TRAE CLI ${method} timed out`), {
                  method,
                  timeoutMs
                })
              )
            }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer, onReply: options.onReply })
      try {
        this.write({ id, method, params })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'orca_desktop', title: 'Orca', version: '1' },
      capabilities: { experimentalApi: true }
    })
    this.write({ method: 'initialized' })
  }

  respond(id: number | string, result: unknown): void {
    this.write({ id, result })
  }

  reject(id: number | string, message: string): void {
    this.write({ id, error: { code: -32000, message } })
  }

  pauseReading(): void {
    this.reader.pause()
  }

  resumeReading(): void {
    this.reader.resume()
  }

  async close(): Promise<boolean> {
    this.closing = true
    const result = await this.managed.close(this.tree)
    if (result.root === 'exited') {
      await this.outputDrained.promise
    }
    this.failPending(new Error('TRAE CLI connection closed'))
    return result.root === 'exited' || result.killDelivered === true
  }

  private write(frame: Record<string, unknown>): void {
    if (this.closed || !this.managed.child.stdin.writable) {
      throw this.failure ?? new Error('TRAE CLI connection is closed')
    }
    this.managed.child.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  private receive(value: unknown): void {
    const frame = traexRecord(value)
    const method = frame.method
    const id = frame.id
    if (typeof method === 'string') {
      if (typeof id === 'number' || typeof id === 'string') {
        if (this.handlers.onRequest) {
          this.handlers.onRequest({ id, method, params: frame.params })
        } else {
          this.reject(id, 'Orca did not negotiate this request')
        }
      } else {
        this.handlers.onNotification?.(method, frame.params)
      }
      return
    }
    if (typeof id !== 'number') {
      this.failProtocol(new Error('TRAE CLI emitted an unreadable response'))
      return
    }
    const pending = this.pending.get(id)
    if (!pending) {
      return
    }
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (frame.error !== undefined) {
      const error = traexRecord(frame.error)
      pending.reject(
        new TraexRequestError(
          pending.method,
          typeof error.code === 'number' ? error.code : null,
          typeof error.message === 'string' ? error.message : 'TRAE CLI request failed',
          error.data
        )
      )
    } else {
      try {
        pending.onReply?.(frame.result)
        pending.resolve(frame.result)
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private failProtocol(error: Error): void {
    if (this.closing || this.failure) {
      return
    }
    this.failure = error
    this.failPending(error)
    this.handlers.onProtocolFailure?.(error)
    void this.managed.close()
  }
}
