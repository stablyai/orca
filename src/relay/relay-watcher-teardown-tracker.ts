import type { WatcherProcessSubscription } from '../main/ipc/parcel-watcher-process'
import { isWatcherProcessFailure } from '../main/ipc/parcel-watcher-process-failure'
import type { PromiseSettlementWaiters } from '../shared/promise-settlement-waiters'

export type RelayWatcherTeardownState = {
  rootKey: string
  rootPath: string
  clients: Map<number, () => boolean>
  clientWatchIds: Map<number, number>
  setupWaiters: PromiseSettlementWaiters<void>
  subscription: WatcherProcessSubscription | null
  abortController: AbortController
  generation: number
  closed: boolean
}

export class RelayWatcherTeardownTracker {
  private readonly pending = new Map<string, Promise<void>>()
  private readonly failed = new Map<string, { state: RelayWatcherTeardownState; error: unknown }>()

  constructor(private readonly forgetRoot: (rootPath: string) => void) {}

  close(state: RelayWatcherTeardownState, removeActiveState: () => void): Promise<void> {
    const pending = this.pending.get(state.rootKey)
    if (pending) {
      return pending
    }
    if (!state.closed) {
      state.closed = true
      state.generation++
      state.abortController.abort()
      state.clients.clear()
      state.clientWatchIds.clear()
      removeActiveState()
    }
    const subscription = state.subscription
    const teardown = subscription
      ? callUnsubscribe(subscription)
      : state.setupWaiters.promise.then(() => undefined)
    let tracked: Promise<void>
    tracked = teardown
      .then(
        () => {
          state.subscription = null
          this.failed.delete(state.rootKey)
          this.forgetRoot(state.rootPath)
        },
        (error) => {
          const physicalExit = isWatcherProcessFailure(error) ? error.physicalExit : undefined
          if (!subscription && !physicalExit) {
            this.failed.delete(state.rootKey)
            this.forgetRoot(state.rootPath)
            return
          }
          // Why: failed physical teardown must remain retryable and consume capacity.
          this.failed.set(state.rootKey, { state, error })
          if (physicalExit) {
            // Why: an unkillable child still owns native handles until its later
            // physical exit, even when teardown began before setup published.
            void physicalExit.then(() => {
              const failed = this.failed.get(state.rootKey)
              if (failed?.state === state && failed.error === error) {
                this.failed.delete(state.rootKey)
                this.forgetRoot(state.rootPath)
              }
            })
          }
          throw error
        }
      )
      .finally(() => {
        if (this.pending.get(state.rootKey) === tracked) {
          this.pending.delete(state.rootKey)
        }
      })
    this.pending.set(state.rootKey, tracked)
    return tracked
  }

  join(rootKey: string): Promise<void> | undefined {
    const pending = this.pending.get(rootKey)
    const failed = this.failed.get(rootKey)
    if (!pending) {
      return failed ? Promise.reject(failed.error) : undefined
    }
    return pending.then(() => {
      const settledFailure = this.failed.get(rootKey)
      if (settledFailure) {
        throw settledFailure.error
      }
    })
  }

  failedState(rootKey: string): RelayWatcherTeardownState | undefined {
    return this.failed.get(rootKey)?.state
  }

  rootPaths(): string[] {
    return [...this.pending.keys(), ...this.failed.keys()]
  }
}

function callUnsubscribe(subscription: WatcherProcessSubscription): Promise<void> {
  try {
    return Promise.resolve(subscription.unsubscribe())
  } catch (error) {
    return Promise.reject(error)
  }
}
