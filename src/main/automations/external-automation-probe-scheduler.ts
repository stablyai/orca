/**
 * Bounded pool for `{host, provider}` external-manager probes.
 *
 * Probes are always secondary to Orca automation list and mutation traffic, so
 * the pool parks its queue while that work holds a priority lease. Nothing is
 * scheduled speculatively: a caller schedules exactly the scopes it selected,
 * which is what keeps a Local view from reaching out to every SSH target.
 */

export class ExternalAutomationProbeCancelledError extends Error {
  constructor() {
    super('External automation probe was cancelled.')
    this.name = 'ExternalAutomationProbeCancelledError'
  }
}

export function isExternalAutomationProbeCancelled(error: unknown): boolean {
  return error instanceof ExternalAutomationProbeCancelledError
}

export type ExternalAutomationProbeJob<T> = {
  /** `{owner, provider}` identity; a duplicate while one is in flight shares that probe. */
  key: string
  /** Owner key, so leaving a host's scope cancels its probes across providers. */
  scopeKey: string
  run: (signal: AbortSignal) => Promise<T>
}

type QueuedProbe = {
  key: string
  scopeKey: string
  controller: AbortController
  start: () => void
  reject: (error: unknown) => void
}

const DEFAULT_PROBE_CONCURRENCY = 4

export class ExternalAutomationProbeScheduler {
  private readonly concurrency: number
  private readonly queue: QueuedProbe[] = []
  private readonly active = new Set<QueuedProbe>()
  private readonly shared = new Map<string, Promise<unknown>>()
  private priorityHolds = 0

  constructor(options?: { concurrency?: number }) {
    this.concurrency = Math.max(1, options?.concurrency ?? DEFAULT_PROBE_CONCURRENCY)
  }

  get inFlight(): number {
    return this.active.size
  }

  get queued(): number {
    return this.queue.length
  }

  schedule<T>(job: ExternalAutomationProbeJob<T>): Promise<T> {
    const existing = this.shared.get(job.key)
    if (existing) {
      return existing as Promise<T>
    }
    const controller = new AbortController()
    let settled!: Promise<T>
    const promise = new Promise<T>((resolve, reject) => {
      const entry: QueuedProbe = {
        key: job.key,
        scopeKey: job.scopeKey,
        controller,
        reject,
        start: () => {
          this.active.add(entry)
          // Why: settle on abort even when a provider call cannot honour the signal.
          controller.signal.addEventListener(
            'abort',
            () => reject(new ExternalAutomationProbeCancelledError()),
            { once: true }
          )
          void job
            .run(controller.signal)
            .then(resolve, reject)
            .finally(() => {
              this.active.delete(entry)
              if (this.shared.get(entry.key) === settled) {
                this.shared.delete(entry.key)
              }
              this.pump()
            })
        }
      }
      this.queue.push(entry)
    })
    settled = promise.finally(() => {
      this.pump()
    })
    this.shared.set(job.key, settled)
    this.pump()
    return settled
  }

  /** Held for the duration of Orca list/mutation work; queued probes wait behind it. */
  beginPriorityWork(): () => void {
    this.priorityHolds += 1
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      this.priorityHolds = Math.max(0, this.priorityHolds - 1)
      this.pump()
    }
  }

  /** Drops queued and in-flight probes whose scope is no longer selected. */
  retainScopes(activeScopeKeys: Iterable<string>): void {
    const retained = new Set(activeScopeKeys)
    this.cancelWhere((scopeKey) => !retained.has(scopeKey))
  }

  cancelAll(): void {
    this.cancelWhere(() => true)
  }

  private cancelWhere(shouldCancel: (scopeKey: string) => boolean): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const entry = this.queue[index]
      if (entry && shouldCancel(entry.scopeKey)) {
        this.queue.splice(index, 1)
        entry.reject(new ExternalAutomationProbeCancelledError())
        this.shared.delete(entry.key)
      }
    }
    for (const entry of this.active) {
      if (shouldCancel(entry.scopeKey)) {
        entry.controller.abort()
      }
    }
  }

  private pump(): void {
    while (this.priorityHolds === 0 && this.active.size < this.concurrency) {
      const next = this.queue.shift()
      if (!next) {
        return
      }
      next.start()
    }
  }
}
