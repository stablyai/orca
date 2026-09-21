import type { ChildProcess } from 'node:child_process'
import { createAiVaultScanCancelledError } from './ai-vault-scan-cancellation'
import {
  AI_VAULT_SERVICE_IDLE_TIMEOUT_MS,
  AI_VAULT_SERVICE_MAX_CALLS,
  AI_VAULT_SERVICE_READY_TIMEOUT_MS,
  AiVaultServiceIdleRetirement,
  AiVaultServiceInvalidations,
  AiVaultServiceSessionSearchHold,
  aiVaultServiceErrorText,
  attachAiVaultServiceChild,
  cancelAiVaultServiceCall,
  clearAiVaultServiceCall,
  createAiVaultServiceReadyWaiter,
  rejectAiVaultServiceCall,
  requeueOrRejectAiVaultServiceStart,
  retireAiVaultServiceChild,
  sendAiVaultServiceCall,
  type AiVaultServiceClientOptions,
  type AiVaultServicePendingCall,
  type AiVaultServiceReadyWaiter
} from './session-scanner-service-client-state'
import { AiVaultServiceRestartPolicy } from './session-scanner-service-restart-policy'
import {
  aiVaultServiceLane,
  isAiVaultServiceChildMessage,
  type AiVaultSessionSearchInit,
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
  private readonly sessionSearch = new AiVaultServiceSessionSearchHold()
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

  /** Push a consent or retention change, and while the index is on keep a child. */
  updateSessionSearch(init: AiVaultSessionSearchInit): void {
    if (this.disposed) {
      return
    }
    if (!this.sessionSearch.record(init, this.child)) {
      this.scheduleIdleIfNeeded()
      return
    }
    this.idleRetirement.clear()
    this.startSessionSearchChild()
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
    return this.invalidations.send(child, paths, {
      busy: () => this.active.size > 0,
      onFault: (error) => this.onFault(error)
    })
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
        (child) =>
          sendAiVaultServiceCall(
            child,
            call,
            () => this.active.get(call.lane) === call,
            (error) => this.onFault(error)
          ),
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
    this.startSessionSearchChild()
    this.scheduleIdleIfNeeded()
  }

  /**
   * The index's own restart. A child indexing for the hold has no queued call to
   * bring it back, so without this a fault stops the indexing until an unrelated
   * request happens to arrive. The restart delay and circuit bound it, exactly as
   * they bound a queued call's start.
   */
  private startSessionSearchChild(): void {
    if (this.disposed || !this.sessionSearch.holdsChild || this.child || this.readyWaiter) {
      return
    }
    void this.ensureChild().catch((error: unknown) => {
      this.options.onStderr?.(`session search child unavailable: ${aiVaultServiceErrorText(error)}`)
    })
  }

  private retryStartOrReject(call: AiVaultServicePendingCall, error: Error): void {
    requeueOrRejectAiVaultServiceStart(
      call,
      this.queue,
      error,
      !this.disposed && this.restartPolicy.restartScheduled
    )
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
    attachAiVaultServiceChild(child, this.options.init(), {
      onMessage: (message) => this.onMessage(message),
      onFault: (error) => this.onFault(error),
      onStderr: this.options.onStderr
    })
    return waiter.promise
  }

  private onMessage(message: unknown): void {
    if (!isAiVaultServiceChildMessage(message)) {
      this.onFault(new Error('AI Vault service sent a malformed message.'))
      return
    }
    if (message.type === 'sessionSearchRoots') {
      const child = this.child
      const resolve = this.options.resolveSessionSearchRoots
      void Promise.resolve()
        .then(() => (resolve ? resolve() : (this.options.init().sessionSearch?.roots ?? null)))
        .catch(() => null)
        .then((roots) => {
          if (child && this.child === child && child.connected) {
            child.send({ type: 'sessionSearchRoots', id: message.id, roots }, () => undefined)
          }
        })
      return
    }
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
    cancelAiVaultServiceCall(call, {
      queue: this.queue,
      active: this.active,
      child: this.child,
      pump: () => this.pump(),
      onFault: (error) => this.onFault(error)
    })
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
      this.sessionSearch.holdsChild ||
        this.active.size > 0 ||
        this.queue.length > 0 ||
        this.invalidations.size > 0 ||
        !this.child,
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
