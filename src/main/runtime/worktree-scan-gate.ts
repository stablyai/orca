type GateWaiter = {
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  ownerKey: string
  interactive: boolean
  signal?: AbortSignal
  onAbort?: () => void
}

export type WorktreeScanOperation<T> = {
  result: Promise<T>
  settled?: Promise<unknown>
}

export type TrackedWorktreeScanOperation<T> = {
  result: Promise<T>
  settled: Promise<unknown>
}

export type WorktreeScanRunOptions = {
  /** Cancels the wait for a permit only; a started scan keeps running. */
  signal?: AbortSignal
  /** Execution host identity — permits are shared fairly across owners. */
  ownerKey?: string
  /** User-triggered scans use the reserved lane instead of queueing behind the sweep. */
  interactive?: boolean
}

export type WorktreeScanGateOptions = {
  /** Permits only interactive scans may take, so a saturated sweep can't stall a refresh. */
  reservedForInteractive?: number
  /** Last-resort permit reclaim when an operation's resources never report settlement. */
  settlementTimeoutMs?: number
}

const DEFAULT_OWNER_KEY = 'default'
// Why: a tracked SSH scan can legitimately own a permit for its 30s request timeout plus the
// settlement grace, and a local scan for its git timeout plus tree teardown. Sit above both so
// the reclaim only fires on genuinely stuck settlement.
const DEFAULT_SETTLEMENT_TIMEOUT_MS = 60_000

function abortError(): Error {
  const error = new Error('Worktree scan was cancelled before it started.')
  error.name = 'AbortError'
  return error
}

/** Keep the async contract: failures reject `result` instead of throwing at the call site. */
function failedOperation<T>(error: unknown): TrackedWorktreeScanOperation<T> {
  const result = Promise.reject<T>(error)
  // Why: a caller may consume only `settled`; an unconsumed rejection would surface as unhandled.
  void result.catch(() => {})
  return { result, settled: Promise.resolve() }
}

export class WorktreeScanGate {
  private active = 0
  private readonly activeByOwner = new Map<string, number>()
  private readonly waiters: GateWaiter[] = []
  private readonly reservedForInteractive: number
  private readonly settlementTimeoutMs: number

  constructor(
    private readonly limit: number,
    options: WorktreeScanGateOptions = {}
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('Worktree scan concurrency must be a positive integer.')
    }
    const reserved = options.reservedForInteractive ?? 0
    if (!Number.isInteger(reserved) || reserved < 0 || reserved >= limit) {
      throw new Error('Worktree scan interactive reserve must leave at least one shared permit.')
    }
    this.reservedForInteractive = reserved
    this.settlementTimeoutMs = options.settlementTimeoutMs ?? DEFAULT_SETTLEMENT_TIMEOUT_MS
  }

  run<T>(start: () => WorktreeScanOperation<T>, options?: WorktreeScanRunOptions): Promise<T> {
    return this.runTracked(start, options).result
  }

  runTracked<T>(
    start: () => WorktreeScanOperation<T>,
    options: WorktreeScanRunOptions = {}
  ): TrackedWorktreeScanOperation<T> {
    const ownerKey = options.ownerKey ?? DEFAULT_OWNER_KEY
    const interactive = options.interactive === true
    if (options.signal?.aborted) {
      return failedOperation<T>(abortError())
    }
    if (this.hasCapacityFor(interactive)) {
      const release = this.acquirePermit(ownerKey)
      try {
        return this.startOperation(start, release, ownerKey)
      } catch (error) {
        return failedOperation<T>(error)
      }
    }
    const acquisition = this.acquire(ownerKey, interactive, options.signal)
    const operation = acquisition.then((release) => {
      if (options.signal?.aborted) {
        release()
        throw abortError()
      }
      return this.startOperation(start, release, ownerKey)
    })
    return {
      result: operation.then((tracked) => tracked.result),
      settled: operation.then(
        (tracked) =>
          tracked.settled.then(
            () => undefined,
            () => undefined
          ),
        () => undefined
      )
    }
  }

  private startOperation<T>(
    start: () => WorktreeScanOperation<T>,
    release: () => void,
    ownerKey: string
  ): TrackedWorktreeScanOperation<T> {
    let operation: WorktreeScanOperation<T>
    try {
      operation = start()
    } catch (error) {
      release()
      throw error
    }
    const settled = operation.settled ?? operation.result
    // Why: settlement promises come from process trees and remote peers, and any of them can stop
    // reporting (disposed mux, wedged descendant). Without this reclaim a leaked permit is
    // permanent and enough of them freeze scanning for every host until restart.
    const reclaim = setTimeout(() => {
      console.warn(
        `[worktree-scan] reclaiming a scan permit for ${ownerKey}; its resources never reported settlement.`
      )
      release()
    }, this.settlementTimeoutMs)
    reclaim.unref?.()
    const releaseOnce = (): void => {
      clearTimeout(reclaim)
      release()
    }
    void settled.then(releaseOnce, releaseOnce)
    return { result: operation.result, settled }
  }

  private hasCapacityFor(interactive: boolean): boolean {
    const limit = interactive ? this.limit : this.limit - this.reservedForInteractive
    return this.active < limit
  }

  private acquire(
    ownerKey: string,
    interactive: boolean,
    signal?: AbortSignal
  ): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(abortError())
    }
    return new Promise((resolve, reject) => {
      const waiter: GateWaiter = { resolve, reject, ownerKey, interactive, signal }
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index === -1) {
            return
          }
          this.waiters.splice(index, 1)
          reject(abortError())
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiters.push(waiter)
    })
  }

  private acquirePermit(ownerKey: string): () => void {
    this.active += 1
    this.activeByOwner.set(ownerKey, (this.activeByOwner.get(ownerKey) ?? 0) + 1)
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      this.active -= 1
      const owned = (this.activeByOwner.get(ownerKey) ?? 1) - 1
      if (owned > 0) {
        this.activeByOwner.set(ownerKey, owned)
      } else {
        this.activeByOwner.delete(ownerKey)
      }
      this.startNext()
    }
  }

  /**
   * Interactive waiters win first; otherwise the host holding the fewest permits goes next, so a
   * slow or dead host's backlog can't monopolize the pool. Ties keep FIFO order.
   */
  private outranks(candidate: GateWaiter, best: GateWaiter): boolean {
    if (candidate.interactive !== best.interactive) {
      return candidate.interactive
    }
    return this.ownedPermits(candidate.ownerKey) < this.ownedPermits(best.ownerKey)
  }

  private ownedPermits(ownerKey: string): number {
    return this.activeByOwner.get(ownerKey) ?? 0
  }

  private startNext(): void {
    while (this.waiters.length > 0) {
      let bestIndex = -1
      for (const [index, candidate] of this.waiters.entries()) {
        if (!this.hasCapacityFor(candidate.interactive)) {
          continue
        }
        if (bestIndex === -1 || this.outranks(candidate, this.waiters[bestIndex])) {
          bestIndex = index
        }
      }
      if (bestIndex === -1) {
        return
      }
      const [waiter] = this.waiters.splice(bestIndex, 1)
      if (waiter.onAbort) {
        waiter.signal?.removeEventListener('abort', waiter.onAbort)
      }
      if (waiter.signal?.aborted) {
        waiter.reject(abortError())
        continue
      }
      waiter.resolve(this.acquirePermit(waiter.ownerKey))
    }
  }
}
