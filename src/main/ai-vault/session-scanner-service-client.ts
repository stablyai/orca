import type { ChildProcess } from 'node:child_process'
import { createAiVaultScanCancelledError } from './ai-vault-scan-cancellation'
import {
  AI_VAULT_SERVICE_IDLE_TIMEOUT_MS,
  AI_VAULT_SERVICE_INTERACTIVE_TIMEOUT_MS,
  AI_VAULT_SERVICE_MAX_CALLS,
  AI_VAULT_SERVICE_READY_TIMEOUT_MS,
  AI_VAULT_SERVICE_SCAN_TIMEOUT_MS,
  AiVaultServiceIdleRetirement,
  AiVaultServiceInvalidations,
  armAiVaultServiceCancellationTimeout,
  attachAiVaultServiceChild,
  clearAiVaultServiceCall,
  createAiVaultServiceReadyWaiter,
  rejectAiVaultServiceCall,
  requeueAiVaultServiceStart,
  retireAiVaultServiceChild,
  type AiVaultServiceClientOptions,
  type AiVaultServicePendingCall,
  type AiVaultServiceReadyWaiter
} from './session-scanner-service-client-state'
import { AiVaultServiceRestartPolicy } from './session-scanner-service-restart-policy'
import {
  aiVaultServiceLane,
  isAiVaultServiceChildMessage,
  type AiVaultServiceChildMessage,
  type AiVaultServiceRequest,
  type AiVaultServiceRequestBody,
  type AiVaultServiceResultValue
} from './session-scanner-service-protocol'

export class AiVaultScannerServiceClient {
  private child: ChildProcess | null = null
  private readyWaiter: AiVaultServiceReadyWaiter | null = null
  private readonly active = new Map<AiVaultServicePendingCall['lane'], AiVaultServicePendingCall>()
  private readonly queue: AiVaultServicePendingCall[] = []
  private readonly invalidations = new AiVaultServiceInvalidations()
  private nextId = 1
  private readonly idleRetirement = new AiVaultServiceIdleRetirement()
  private readonly restartPolicy = new AiVaultServiceRestartPolicy()
  private disposed = false

  constructor(private readonly options: AiVaultServiceClientOptions) {}

  request<T>(body: AiVaultServiceRequestBody, signal?: AbortSignal): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('AI Vault service client was disposed.'))
    }
    if (signal?.aborted) {
      return Promise.reject(createAiVaultScanCancelledError())
    }
    if (this.queue.length + this.active.size >= AI_VAULT_SERVICE_MAX_CALLS) {
      return Promise.reject(new Error('AI Vault service queue is full.'))
    }
    const request = { ...body, id: this.nextId++ } as AiVaultServiceRequest
    return new Promise<T>((resolve, reject) => {
      const call: AiVaultServicePendingCall = {
        request,
        lane: aiVaultServiceLane(request.operation),
        signal,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: null,
        onAbort: null,
        cancelled: false,
        sent: false,
        startRetried: false
      }
      if (signal) {
        call.onAbort = () => this.cancel(call)
        signal.addEventListener('abort', call.onAbort, { once: true })
      }
      this.queue.push(call)
      this.idleRetirement.clear()
      this.pump()
    })
  }

  clearRestartCircuit(): void {
    this.restartPolicy.clearCircuit()
    this.pump()
  }

  async invalidate(paths: string[]): Promise<void> {
    if (paths.length === 0 || this.disposed) {
      return
    }
    this.idleRetirement.clear()
    const child = await this.ensureChild()
    return this.invalidations.open(
      AI_VAULT_SERVICE_READY_TIMEOUT_MS,
      (generation) => this.onInvalidationDeadline(generation),
      (generation) => child.send({ type: 'invalidate', generation, paths })
    )
  }

  /**
   * The deadline is a startup-sized budget, but a child mid-scan can be slow to
   * turn the channel around. Fork IPC ordering already guarantees the child
   * applies the invalidation before any request sent after it, so a busy child
   * owes nothing here — only an idle one that misses the deadline is wedged.
   */
  private onInvalidationDeadline(generation: number): void {
    if (this.active.size > 0) {
      this.invalidations.settle(generation)
      return
    }
    this.onFault(new Error('AI Vault service cache invalidation timed out.'))
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.restartPolicy.dispose()
    this.idleRetirement.clear()
    const error = new Error('AI Vault service client was disposed.')
    for (const call of [...this.active.values(), ...this.queue]) {
      rejectAiVaultServiceCall(call, error)
    }
    this.active.clear()
    this.queue.length = 0
    this.invalidations.rejectAll(error)
    this.retireChild()
  }

  private pump(): void {
    if (this.restartPolicy.restartScheduled) {
      return
    }
    for (const lane of ['cache', 'interactive'] as const) {
      if (this.active.has(lane)) {
        continue
      }
      const index = this.queue.findIndex((call) => call.lane === lane)
      if (index === -1) {
        continue
      }
      const call = this.queue.splice(index, 1)[0]!
      this.active.set(lane, call)
      void this.ensureChild().then(
        (child) => this.sendCall(child, call),
        (error: Error) => {
          if (this.active.get(lane) !== call) {
            return
          }
          this.active.delete(lane)
          this.retryStartOrReject(call, error)
          this.pump()
        }
      )
    }
    this.scheduleIdleIfNeeded()
  }

  private sendCall(child: ChildProcess, call: AiVaultServicePendingCall): void {
    if (call.cancelled || this.active.get(call.lane) !== call) {
      return
    }
    const timeoutMs =
      call.request.operation === 'scan'
        ? AI_VAULT_SERVICE_SCAN_TIMEOUT_MS
        : AI_VAULT_SERVICE_INTERACTIVE_TIMEOUT_MS
    call.timer = setTimeout(() => {
      this.onFault(new Error(`AI Vault service timed out after ${timeoutMs}ms.`))
    }, timeoutMs)
    call.timer.unref?.()
    call.sent = true
    child.send(call.request)
  }

  private retryStartOrReject(call: AiVaultServicePendingCall, error: Error): void {
    if (
      this.disposed ||
      !this.restartPolicy.restartScheduled ||
      !requeueAiVaultServiceStart(call, this.queue)
    ) {
      rejectAiVaultServiceCall(call, error)
    }
  }

  private ensureChild(): Promise<ChildProcess> {
    if (this.child && !this.readyWaiter) {
      return Promise.resolve(this.child)
    }
    if (this.readyWaiter) {
      return this.readyWaiter.promise
    }
    const startError = this.restartPolicy.startError()
    if (startError) {
      return Promise.reject(startError)
    }
    let child: ChildProcess
    try {
      child = this.options.processFactory()
    } catch (error) {
      this.restartPolicy.recordFault(() => this.pump())
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    this.child = child
    const waiter = createAiVaultServiceReadyWaiter(AI_VAULT_SERVICE_READY_TIMEOUT_MS, () =>
      this.onFault(new Error('AI Vault service did not become ready.'))
    )
    this.readyWaiter = waiter
    attachAiVaultServiceChild(child, this.options.init, {
      onMessage: (message) => this.onMessage(message),
      onFault: (error) => this.onFault(error),
      onStderr: this.options.onStderr
    })
    return waiter.promise
  }

  private onMessage(raw: unknown): void {
    if (!isAiVaultServiceChildMessage(raw)) {
      this.onFault(new Error('AI Vault service sent a malformed message.'))
      return
    }
    const message = raw as AiVaultServiceChildMessage
    if (message.type === 'ready') {
      const waiter = this.readyWaiter
      if (!waiter || !this.child) {
        return
      }
      clearTimeout(waiter.timer)
      this.readyWaiter = null
      waiter.resolve(this.child)
      return
    }
    if (message.type === 'invalidated') {
      if (this.invalidations.settle(message.generation)) {
        this.scheduleIdleIfNeeded()
      }
      return
    }
    const call = [...this.active.values()].find((entry) => entry.request.id === message.id)
    if (!call) {
      return
    }
    this.active.delete(call.lane)
    clearAiVaultServiceCall(call)
    if (!call.cancelled) {
      if (message.type === 'error') {
        call.reject(new Error(message.message))
      } else {
        call.resolve((message as { value: AiVaultServiceResultValue['value'] }).value)
      }
    }
    this.pump()
  }

  private cancel(call: AiVaultServicePendingCall): void {
    if (call.cancelled) {
      return
    }
    call.cancelled = true
    call.reject(createAiVaultScanCancelledError())
    const queuedIndex = this.queue.indexOf(call)
    if (queuedIndex !== -1) {
      this.queue.splice(queuedIndex, 1)
      clearAiVaultServiceCall(call)
      this.pump()
      return
    }
    if (this.active.get(call.lane) === call) {
      // Why: a call cancelled before it reached the child gets no acknowledgement,
      // so waiting on one would kill a healthy service and stall the lane.
      if (!call.sent) {
        this.active.delete(call.lane)
        clearAiVaultServiceCall(call)
        this.pump()
        return
      }
      this.child?.send({ type: 'cancel', id: call.request.id })
      armAiVaultServiceCancellationTimeout(call, () =>
        this.onFault(new Error('AI Vault service did not cancel within 2000ms.'))
      )
    }
  }

  private onFault(error: Error): void {
    const child = this.child
    if (!child) {
      return
    }
    this.child = null
    child.removeAllListeners()
    child.kill()
    if (this.readyWaiter) {
      clearTimeout(this.readyWaiter.timer)
      this.readyWaiter.reject(error)
      this.readyWaiter = null
    }
    // Recorded before the pending calls are settled so retryStartOrReject can see
    // whether a respawn is actually coming.
    this.restartPolicy.recordFault(() => this.pump())
    const active = [...this.active.values()]
    this.active.clear()
    for (const call of active) {
      this.retryStartOrReject(call, error)
    }
    this.invalidations.rejectAll(error)
  }

  private scheduleIdleIfNeeded(): void {
    this.idleRetirement.schedule(
      this.active.size > 0 || this.queue.length > 0 || this.invalidations.size > 0 || !this.child,
      this.options.idleTimeoutMs ?? AI_VAULT_SERVICE_IDLE_TIMEOUT_MS,
      () => this.retireChild()
    )
  }

  private retireChild(): void {
    this.idleRetirement.clear()
    const child = this.child
    this.child = null
    if (!child) {
      return
    }
    retireAiVaultServiceChild(child)
  }
}

export type { AiVaultServiceProcessFactory } from './session-scanner-service-client-state'
