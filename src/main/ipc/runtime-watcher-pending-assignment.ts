import { WatcherProcessFailure } from './parcel-watcher-process-failure'
import type { WatcherProcessHooks } from './parcel-watcher-process-subscription'
import { PromiseSettlementWaiters } from '../../shared/promise-settlement-waiters'

const DEFAULT_QUARANTINE_WAIT_TIMEOUT_MS = 60_000

export class RuntimeWatcherPendingAssignment<T> {
  private readonly settlementWaiters: PromiseSettlementWaiters<T>
  private settledNotified = false

  constructor(
    basePromise: Promise<T>,
    private readonly onNoWaiters: () => void,
    private readonly onSettled: () => void
  ) {
    this.settlementWaiters = new PromiseSettlementWaiters(basePromise, () => this.notifySettled())
  }

  get waiterCount(): number {
    return this.settlementWaiters.waiterCount
  }

  wait(hooks: WatcherProcessHooks, onGranted: (assignment: T) => void): Promise<T> {
    return this.settlementWaiters.wait({
      signal: hooks.signal,
      timeoutMs: hooks.subscribeTimeoutMs ?? DEFAULT_QUARANTINE_WAIT_TIMEOUT_MS,
      createAbortError: createAssignmentAbortError,
      createTimeoutError: createAssignmentTimeoutError,
      onFulfilled: onGranted,
      onAbandon: () => {
        if (this.settlementWaiters.waiterCount === 0) {
          // Why: delete the logically abandoned assignment synchronously so a
          // same-turn replacement cannot join its soon-to-reject promise.
          this.notifySettled()
          this.onNoWaiters()
        }
      }
    })
  }

  private notifySettled(): void {
    if (this.settledNotified) {
      return
    }
    this.settledNotified = true
    this.onSettled()
  }
}

function createAssignmentAbortError(): WatcherProcessFailure {
  return new WatcherProcessFailure(
    'file watcher subscription aborted',
    'subscription',
    'subscribe_aborted'
  )
}

function createAssignmentTimeoutError(): WatcherProcessFailure {
  return new WatcherProcessFailure(
    'file watcher subscription timed out waiting for quarantine capacity',
    'subscription',
    'subscribe_timeout'
  )
}
