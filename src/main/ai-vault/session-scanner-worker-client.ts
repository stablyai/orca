import type { Worker } from 'node:worker_threads'
import type { AiVaultListResult } from '../../shared/ai-vault-types'
import type {
  AiVaultSessionTitleRequest,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import { createAiVaultScanCancelledError } from './ai-vault-scan-cancellation'
import type {
  AiVaultWorkerRequest,
  AiVaultWorkerResponse,
  AiVaultWorkerScanOptions
} from './session-scanner-worker-protocol'

const SCAN_TIMEOUT_MS = 130_000
const TITLE_TIMEOUT_MS = 15_000
const MAX_QUEUED_CALLS = 16

export type AiVaultWorkerFactory = () => Worker

type RequestBody =
  | Omit<Extract<AiVaultWorkerRequest, { kind: 'scan' }>, 'id'>
  | Omit<Extract<AiVaultWorkerRequest, { kind: 'titles' }>, 'id'>

type PendingCall = {
  request: AiVaultWorkerRequest
  timeoutMs: number
  signal?: AbortSignal
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
  onAbort: (() => void) | null
  cancelled: boolean
}

export class AiVaultScannerWorkerClient {
  private worker: Worker | null = null
  private active: PendingCall | null = null
  private queue: PendingCall[] = []
  private nextId = 1
  private readonly workerFactory: AiVaultWorkerFactory

  constructor(options: { workerFactory: AiVaultWorkerFactory }) {
    this.workerFactory = options.workerFactory
  }

  scan(
    options: AiVaultWorkerScanOptions,
    signal?: AbortSignal
  ): Promise<{ result: AiVaultListResult; durationMs: number }> {
    return this.dispatch({ kind: 'scan', options }, SCAN_TIMEOUT_MS, signal) as Promise<{
      result: AiVaultListResult
      durationMs: number
    }>
  }

  resolveTitles(
    requests: AiVaultSessionTitleRequest[],
    signal?: AbortSignal
  ): Promise<AiVaultSessionTitlesResult> {
    return this.dispatch(
      { kind: 'titles', requests },
      TITLE_TIMEOUT_MS,
      signal
    ) as Promise<AiVaultSessionTitlesResult>
  }

  dispose(): void {
    this.destroyWorker()
    const pending = this.queue
    this.queue = []
    for (const call of pending) {
      this.rejectCall(call, new Error('AI Vault scanner worker was disposed.'))
    }
    if (this.active) {
      this.rejectCall(this.active, new Error('AI Vault scanner worker was disposed.'))
      this.active = null
    }
  }

  private dispatch(body: RequestBody, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) {
      return Promise.reject(createAiVaultScanCancelledError())
    }
    if (this.queue.length >= MAX_QUEUED_CALLS) {
      return Promise.reject(new Error('AI Vault scanner worker queue is full.'))
    }
    return new Promise((resolve, reject) => {
      const call: PendingCall = {
        request: { ...body, id: this.nextId++ } as AiVaultWorkerRequest,
        timeoutMs,
        signal,
        resolve,
        reject,
        timer: null,
        onAbort: null,
        cancelled: false
      }
      if (signal) {
        call.onAbort = () => this.cancel(call)
        signal.addEventListener('abort', call.onAbort, { once: true })
      }
      this.queue.push(call)
      this.pump()
    })
  }

  private pump(): void {
    if (this.active || this.queue.length === 0) {
      return
    }
    const worker = this.ensureWorker()
    if (!worker) {
      this.failQueue(new Error('AI Vault background scanner could not start.'))
      return
    }
    const call = this.queue.shift()
    if (!call) {
      return
    }
    this.active = call
    call.timer = setTimeout(() => {
      this.onWorkerFault(new Error(`AI Vault scanner worker timed out after ${call.timeoutMs}ms.`))
    }, call.timeoutMs)
    call.timer.unref?.()
    worker.postMessage(call.request)
  }

  private ensureWorker(): Worker | null {
    if (this.worker) {
      return this.worker
    }
    try {
      const worker = this.workerFactory()
      worker.on('message', (response: AiVaultWorkerResponse) => this.onMessage(response))
      worker.on('error', (error: Error) => this.onWorkerFault(error))
      worker.on('exit', (code: number) => {
        if (code !== 0 || this.active || this.queue.length > 0) {
          this.onWorkerFault(new Error(`AI Vault scanner worker exited with code ${code}.`))
        } else {
          this.destroyWorker()
        }
      })
      worker.unref?.()
      this.worker = worker
      return worker
    } catch {
      return null
    }
  }

  private onMessage(response: AiVaultWorkerResponse): void {
    const call = this.active
    if (!call || call.request.id !== response.id) {
      return
    }
    this.active = null
    this.clearCall(call)
    if (!call.cancelled) {
      if (response.ok) {
        call.resolve(response.value)
      } else {
        call.reject(new Error(response.error))
      }
    }
    this.afterSettle()
  }

  private cancel(call: PendingCall): void {
    if (call.cancelled) {
      return
    }
    call.cancelled = true
    call.reject(createAiVaultScanCancelledError())
    if (this.active === call) {
      this.worker?.postMessage({ id: call.request.id, kind: 'cancel' })
      return
    }
    const index = this.queue.indexOf(call)
    if (index !== -1) {
      this.queue.splice(index, 1)
      this.clearCall(call)
    }
  }

  private onWorkerFault(error: Error): void {
    const active = this.active
    this.active = null
    this.destroyWorker()
    if (active) {
      this.rejectCall(active, error)
    }
    if (this.queue.length > 0) {
      this.pump()
    }
  }

  private rejectCall(call: PendingCall, error: Error): void {
    this.clearCall(call)
    if (!call.cancelled) {
      call.reject(error)
    }
  }

  private failQueue(error: Error): void {
    const pending = this.queue
    this.queue = []
    for (const call of pending) {
      this.rejectCall(call, error)
    }
  }

  private clearCall(call: PendingCall): void {
    if (call.timer) {
      clearTimeout(call.timer)
      call.timer = null
    }
    if (call.signal && call.onAbort) {
      call.signal.removeEventListener('abort', call.onAbort)
      call.onAbort = null
    }
  }

  private afterSettle(): void {
    if (this.queue.length > 0) {
      this.pump()
    }
  }

  private destroyWorker(): void {
    const worker = this.worker
    this.worker = null
    if (!worker) {
      return
    }
    worker.removeAllListeners()
    void worker.terminate().catch(() => undefined)
  }
}
