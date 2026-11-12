import { LazyWorkerThreadHost } from '../worker-threads/lazy-worker-thread-host'
import type { WorkerThreadFactory } from '../worker-threads/worker-thread-transport'
import {
  isUsageScanWorkerProgress,
  type UsageScanWorkerMessage,
  type UsageScanWorkerRequest,
  type UsageScanWorkerRequestBody,
  type UsageScanWorkerResponse
} from './scan-worker/usage-scan-worker-protocol'

type ScanCall = {
  request: UsageScanWorkerRequest
  timeoutMs: number
  timer: NodeJS.Timeout | null
  resolve: (response: UsageScanWorkerResponse) => void
  reject: (error: Error) => void
}

/** Independent providers share a worker; each provider and cache split retain exclusive ownership. */
export class UsageScanRequestScheduler {
  private readonly active = new Map<number, ScanCall>()
  private pending: ScanCall[] = []
  private nextId = 1
  private consecutiveDeaths = 0
  private disposed = false
  private retirementWait: Promise<void> | null = null
  private readonly host: LazyWorkerThreadHost<UsageScanWorkerMessage>

  constructor(
    private readonly options: {
      factory: WorkerThreadFactory
      idleTeardownMs: number
      maxConsecutiveDeaths: number
      createUnavailableError: (message: string) => Error
      onUnavailable: (error: unknown) => void
    }
  ) {
    this.host = new LazyWorkerThreadHost({
      factory: options.factory,
      idleTeardownMs: options.idleTeardownMs,
      onMessage: (response) => this.onMessage(response),
      onError: (error) => this.onFault(error),
      onExit: (code) => this.onExit(code),
      isIdle: () => this.active.size === 0 && this.pending.length === 0,
      onUnavailable: options.onUnavailable,
      awaitRetirement: true,
      strictRetirement: true
    })
  }

  dispatch(body: UsageScanWorkerRequestBody, timeoutMs: number): Promise<UsageScanWorkerResponse> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('Usage scan scheduler disposed'))
        return
      }
      if (this.active.size === 0 && this.pending.length === 0) {
        this.consecutiveDeaths = 0
      }
      this.pending.push({
        request: { ...body, id: this.nextId++ },
        timeoutMs,
        timer: null,
        resolve,
        reject
      })
      this.pump()
    })
  }

  dispose(): void {
    this.disposed = true
    this.host.destroy()
    const calls = [...this.active.values(), ...this.pending]
    this.pending = []
    for (const call of calls) {
      this.settle(call, () => call.reject(new Error('Usage scan scheduler disposed')))
    }
  }

  retired(): Promise<void> {
    return this.host.retired()
  }

  private pump(): void {
    if (this.disposed) {
      return
    }
    if (this.pending.length === 0) {
      if (this.active.size === 0) {
        this.host.scheduleIdleTeardown()
      }
      return
    }
    if (this.host.isRetiring) {
      this.waitForRetirement()
      return
    }
    while (this.pending.length > 0) {
      const index = this.nextEligible()
      if (index < 0) {
        return
      }
      const worker = this.host.ensure()
      if (!worker) {
        this.rejectPending(this.options.createUnavailableError('worker spawn failed'))
        return
      }
      const call = this.pending.splice(index, 1)[0]
      this.active.set(call.request.id, call)
      this.host.clearIdleTimer()
      this.armDeadline(call)
      try {
        worker.postMessage(call.request)
      } catch (error) {
        this.onFault(error instanceof Error ? error : new Error(String(error)))
        return
      }
    }
  }

  private nextEligible(): number {
    const requests = [...this.active.values()].map((call) => call.request)
    if (requests.some((request) => request.operation === 'splitCacheFile')) {
      return -1
    }
    for (let index = 0; index < this.pending.length; index++) {
      const request = this.pending[index].request
      if (request.operation === 'splitCacheFile') {
        return index === 0 && requests.length === 0 ? index : -1
      }
      if (!requests.some((active) => active.providerId === request.providerId)) {
        return index
      }
    }
    return -1
  }

  private waitForRetirement(): void {
    if (this.retirementWait) {
      return
    }
    this.retirementWait = this.host.retired().then(
      () => {
        this.retirementWait = null
        this.pump()
      },
      (error: unknown) => {
        this.retirementWait = null
        this.rejectPending(error instanceof Error ? error : new Error(String(error)))
      }
    )
  }

  private armDeadline(call: ScanCall): void {
    if (call.timer) {
      clearTimeout(call.timer)
    }
    call.timer = setTimeout(() => {
      if (this.active.get(call.request.id) === call) {
        this.onFault(new Error(`Usage scan worker reported no progress for ${call.timeoutMs}ms`))
      }
    }, call.timeoutMs)
    call.timer.unref?.()
  }

  private onMessage(response: UsageScanWorkerMessage): void {
    const call = this.active.get(response.id)
    if (!call) {
      return
    }
    if (isUsageScanWorkerProgress(response)) {
      this.armDeadline(call)
      return
    }
    this.consecutiveDeaths = 0
    this.settle(call, () => call.resolve(response))
    this.pump()
  }

  private onExit(code: number): void {
    if (code === 0 && this.active.size === 0 && this.pending.length === 0) {
      this.host.destroy()
      return
    }
    this.onFault(new Error(`Usage scan worker exited with code ${code}`))
  }

  private onFault(error: Error): void {
    const posted = [...this.active.values()]
    this.host.destroy()
    for (const call of posted) {
      this.settle(call, () => call.reject(error))
    }
    if (posted.length > 0 && ++this.consecutiveDeaths >= this.options.maxConsecutiveDeaths) {
      this.consecutiveDeaths = 0
      this.rejectPending(new Error(`Usage scan worker crashed repeatedly (${error.message})`))
      return
    }
    this.pump()
  }

  private rejectPending(error: Error): void {
    const pending = this.pending
    this.pending = []
    for (const call of pending) {
      this.settle(call, () => call.reject(error))
    }
  }

  private settle(call: ScanCall, finish: () => void): void {
    if (call.timer) {
      clearTimeout(call.timer)
      call.timer = null
    }
    this.active.delete(call.request.id)
    finish()
  }
}
