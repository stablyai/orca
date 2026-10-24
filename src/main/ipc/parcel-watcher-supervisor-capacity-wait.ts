import {
  onWatcherChildCapacityAvailable,
  WatcherChildCapacityError
} from './parcel-watcher-child-registry'
import { watcherHostFailure, WatcherProcessFailure } from './parcel-watcher-process-failure'
import { PromiseSettlementWaiters } from '../../shared/promise-settlement-waiters'

type CapacityWaitState = {
  waiters: PromiseSettlementWaiters<void>
  resolve: () => void
  reject: (error: Error) => void
  cancel: () => void
}

export class WatcherSupervisorCapacityWait {
  private state: CapacityWaitState | null = null
  private lifecycleGeneration = 0

  get waiterCount(): number {
    return this.state?.waiters.waiterCount ?? 0
  }

  run<T>(operation: Promise<T>, retry: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const lifecycleGeneration = this.lifecycleGeneration
    return operation.catch(async (error: unknown) => {
      if (!(error instanceof WatcherChildCapacityError)) {
        throw error
      }
      if (lifecycleGeneration !== this.lifecycleGeneration) {
        throw watcherHostFailure('file watcher supervisor disposed', 'supervisor_disposed')
      }
      await this.wait(signal)
      if (lifecycleGeneration !== this.lifecycleGeneration) {
        throw watcherHostFailure('file watcher supervisor disposed', 'supervisor_disposed')
      }
      // subscribe() owns a fresh capacity wait for each retry, including slots reclaimed by crash recovery.
      return retry()
    })
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(createCapacityAbortError())
    }
    const state = this.state ?? this.createState()
    return state.waiters.wait({
      signal,
      createAbortError: createCapacityAbortError,
      onAbandon: () => {
        if (state.waiters.waiterCount === 0 && this.state === state) {
          // Release the shared listener when the last same-supervisor waiter cancels.
          this.state = null
          state.cancel()
          state.reject(createCapacityAbortError())
        }
      }
    })
  }

  dispose(): void {
    this.lifecycleGeneration++
    const state = this.state
    if (!state) {
      return
    }
    this.state = null
    state.cancel()
    state.reject(
      new WatcherProcessFailure(
        'file watcher supervisor disposed',
        'supervisor',
        'supervisor_disposed'
      )
    )
  }

  private createState(): CapacityWaitState {
    let resolve = (): void => undefined
    let reject = (_error: Error): void => undefined
    const promise = new Promise<void>((nextResolve, nextReject) => {
      resolve = nextResolve
      reject = nextReject
    })
    const state: CapacityWaitState = {
      waiters: new PromiseSettlementWaiters(promise),
      resolve,
      reject,
      cancel: () => undefined
    }
    this.state = state
    // One physical slot launches the shared child for all roots awaiting this barrier.
    state.cancel = onWatcherChildCapacityAvailable(() => {
      if (this.state === state) {
        this.state = null
      }
      state.resolve()
    })
    return state
  }
}

function createCapacityAbortError(): WatcherProcessFailure {
  return new WatcherProcessFailure(
    'file watcher subscription aborted',
    'subscription',
    'subscribe_aborted'
  )
}
