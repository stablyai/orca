import type {
  RelayWatcherTeardownState,
  RelayWatcherTeardownTracker
} from './relay-watcher-teardown-tracker'
import type { RelayDispatcher } from './dispatcher'
import { emitRelayWatcherTerminalFailure } from './relay-watcher-terminal-notifier'
import { isPathInsideOrEqual } from '../shared/cross-platform-path'
import type { RelayWatcherPendingSetup } from './relay-watcher-setup-tracking'
import { forEachWithConcurrency, mapSettledWithConcurrency } from '../shared/map-with-concurrency'

const RELAY_WATCH_CLOSE_CONCURRENCY = 8

export class RelayWatcherRemovalFence {
  private readonly roots = new Set<string>()
  private readonly operations = new Map<string, number>()
  private readonly operationWaiters = new Map<string, Set<() => void>>()
  private beforeRemove: ((rootKey: string) => Promise<void>) | null = null

  constructor(
    private readonly watches: Map<string, RelayWatcherTeardownState>,
    private readonly pendingSetups: Map<string, RelayWatcherPendingSetup>,
    private readonly teardownTracker: RelayWatcherTeardownTracker,
    private readonly dispatcher: RelayDispatcher
  ) {}

  isActive(rootKey: string): boolean {
    return [...this.roots].some((activeRoot) => isPathInsideOrEqual(activeRoot, rootKey))
  }

  setBeforeRemove(beforeRemove: (rootKey: string) => Promise<void>): void {
    this.beforeRemove = beforeRemove
  }

  beginOperation(operationPath: string): () => void {
    if ([...this.roots].some((rootKey) => isPathInsideOrEqual(rootKey, operationPath))) {
      throw new Error('Remote worktree deletion already in progress')
    }
    this.operations.set(operationPath, (this.operations.get(operationPath) ?? 0) + 1)
    let finished = false
    return () => {
      if (finished) {
        return
      }
      finished = true
      const remaining = (this.operations.get(operationPath) ?? 1) - 1
      if (remaining > 0) {
        this.operations.set(operationPath, remaining)
      } else {
        this.operations.delete(operationPath)
      }
      this.resolveOperationWaiters()
    }
  }

  async run<T>(rootKey: string, operation: () => Promise<T>): Promise<T> {
    if (
      [...this.roots].some(
        (activeRoot) =>
          isPathInsideOrEqual(activeRoot, rootKey) || isPathInsideOrEqual(rootKey, activeRoot)
      )
    ) {
      throw new Error('Remote worktree deletion already in progress')
    }
    this.roots.add(rootKey)
    try {
      await this.waitForOperations(rootKey)
      await this.closeRoot(rootKey)
      await this.beforeRemove?.(rootKey)
      return await operation()
    } finally {
      this.roots.delete(rootKey)
    }
  }

  private hasOperationInside(rootKey: string): boolean {
    return [...this.operations.keys()].some((operationPath) =>
      isPathInsideOrEqual(rootKey, operationPath)
    )
  }

  private waitForOperations(rootKey: string): Promise<void> {
    if (!this.hasOperationInside(rootKey)) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const waiters = this.operationWaiters.get(rootKey) ?? new Set<() => void>()
      waiters.add(resolve)
      this.operationWaiters.set(rootKey, waiters)
    })
  }

  private resolveOperationWaiters(): void {
    for (const [rootKey, waiters] of this.operationWaiters) {
      if (this.hasOperationInside(rootKey)) {
        continue
      }
      this.operationWaiters.delete(rootKey)
      for (const resolve of waiters) {
        resolve()
      }
    }
  }

  private async closeRoot(rootKey: string): Promise<void> {
    const pending = [...this.pendingSetups.entries()].filter(([setupRoot]) =>
      isPathInsideOrEqual(rootKey, setupRoot)
    )
    await forEachWithConcurrency(pending, RELAY_WATCH_CLOSE_CONCURRENCY, async ([, setup]) => {
      await setup.promise.catch(() => undefined)
    })
    const states = [...this.watches.entries()]
      .filter(([watchRoot]) => isPathInsideOrEqual(rootKey, watchRoot))
      .map(([, state]) => state)
    for (const state of states) {
      emitRelayWatcherTerminalFailure(this.dispatcher, state, 'Remote worktree is being removed')
      state.clients.clear()
      state.clientWatchIds.clear()
    }
    const closes = await mapSettledWithConcurrency(states, RELAY_WATCH_CLOSE_CONCURRENCY, (state) =>
      this.closeWatch(state)
    )
    const failedClose = closes.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (failedClose) {
      throw failedClose.reason
    }
    const trackedRoots = this.teardownTracker
      .rootPaths()
      .filter((trackedRoot) => isPathInsideOrEqual(rootKey, trackedRoot))
    for (const trackedRoot of trackedRoots) {
      const failed = this.teardownTracker.failedState(trackedRoot)
      await (failed ? this.closeWatch(failed) : this.teardownTracker.join(trackedRoot))
    }
  }

  private closeWatch(state: RelayWatcherTeardownState): Promise<void> {
    return this.teardownTracker.close(state, () => {
      if (this.watches.get(state.rootKey) === state) {
        this.watches.delete(state.rootKey)
      }
    })
  }
}
