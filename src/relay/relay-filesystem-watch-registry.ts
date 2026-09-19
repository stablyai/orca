import type { RelayDispatcher, RequestContext } from './dispatcher'
import { MAX_BATCHED_WATCHER_EVENTS } from '../main/ipc/filesystem-watcher-event-batch'
import {
  WATCHER_IGNORE_DIRS,
  buildParcelWatcherIgnoreOptions
} from '../main/ipc/filesystem-watcher-ignore'
import {
  createRelayWatcherProcessPool,
  type RelayWatcherProcessPool
} from './relay-watcher-process-pool'
import { emitRelayWatcherEvents, emitRelayWatcherOverflow } from './relay-watcher-event-emitter'
import { awaitRelayWatcherSetupForClient, startInitialRelayWatch } from './relay-watcher-setup-wait'
import {
  RelayWatcherTeardownTracker,
  type RelayWatcherTeardownState
} from './relay-watcher-teardown-tracker'
import { emitRelayWatcherTerminalFailure } from './relay-watcher-terminal-notifier'
import { RelayWatchRootCapacityGate } from './relay-watch-root-capacity-gate'
import { normalizeRuntimePathForComparison } from '../shared/cross-platform-path'
import {
  trackRelayWatcherSetup,
  type RelayWatcherPendingSetup
} from './relay-watcher-setup-tracking'
import { RelayWatcherRemovalFence } from './relay-watcher-removal-fence'
import { releaseStaleRelayWatches } from './relay-watcher-stale-client-release'
import { PromiseSettlementWaiters } from '../shared/promise-settlement-waiters'
import { joinRelayWatcherPendingSetup } from './relay-watcher-pending-setup-join'
import { createRelayWatcherState } from './relay-watcher-state'
import { closeRelayWatchesAndWait, disposeRelayWatchesAndWait } from './relay-watcher-shutdown'

const RELAY_WATCH_OPTIONS = buildParcelWatcherIgnoreOptions(WATCHER_IGNORE_DIRS)

export class RelayFilesystemWatchRegistry {
  private readonly watches = new Map<string, RelayWatcherTeardownState>()
  private readonly pendingSetups = new Map<string, RelayWatcherPendingSetup>()
  private readonly capacityGate = new RelayWatchRootCapacityGate(
    this.watches,
    this.pendingSetups,
    () => this.teardownTracker
  )
  private readonly teardownTracker: RelayWatcherTeardownTracker
  private readonly removalFence: RelayWatcherRemovalFence
  private disposed = false

  constructor(
    private readonly dispatcher: RelayDispatcher,
    private readonly watcherPool: RelayWatcherProcessPool = createRelayWatcherProcessPool()
  ) {
    this.teardownTracker = new RelayWatcherTeardownTracker((rootPath) =>
      this.watcherPool.forgetRoot(rootPath)
    )
    this.removalFence = new RelayWatcherRemovalFence(
      this.watches,
      this.pendingSetups,
      this.teardownTracker,
      this.dispatcher
    )
    this.dispatcher.onClientDetached?.((clientId) => this.releaseClientWatches(clientId))
  }

  watch(rootPath: string, context?: RequestContext, watchId?: number): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('relay_watcher_shutdown_fenced'))
    }
    const rootKey = normalizeRuntimePathForComparison(rootPath)
    if (this.removalFence.isActive(rootKey)) {
      return Promise.reject(new Error('Remote worktree deletion already in progress'))
    }
    const existing = this.watches.get(rootKey)
    if (existing) {
      const hasLiveClient = [...existing.clients.values()].some((isStale) => !isStale())
      if (hasLiveClient) {
        const clientId = context?.clientId ?? 0
        existing.clients.set(clientId, context?.isStale ?? (() => false))
        if (watchId !== undefined) {
          existing.clientWatchIds.set(clientId, watchId)
        }
        return awaitRelayWatcherSetupForClient(existing, context, () =>
          this.releaseWatchClient(existing, clientId)
        )
      }
      void this.closeWatch(existing).catch(() => {})
    }
    const pendingSetup = this.pendingSetups.get(rootKey)
    if (pendingSetup) {
      const retry = (): Promise<void> => this.watch(rootPath, context, watchId)
      return joinRelayWatcherPendingSetup(pendingSetup, context?.signal, retry)
    }
    const setup = this.installWatch(rootKey, rootPath, context, watchId)
    return trackRelayWatcherSetup(this.pendingSetups, rootKey, setup)
  }

  private async installWatch(
    rootKey: string,
    rootPath: string,
    context?: RequestContext,
    watchId?: number
  ): Promise<void> {
    const staleTeardown = releaseStaleRelayWatches(this.watches.values(), (state) =>
      this.closeWatch(state)
    )
    if (staleTeardown) {
      await staleTeardown
    }
    const rootTeardown = this.teardownTracker.join(rootKey)
    if (rootTeardown) {
      await rootTeardown
    }
    const capacityRelease = this.capacityGate.release(rootKey, context?.signal)
    if (capacityRelease) {
      await capacityRelease
    }
    if (this.disposed) {
      throw new Error('relay_watcher_shutdown_fenced')
    }
    const clientId = context?.clientId ?? 0
    const isStale = context?.isStale ?? (() => false)
    const existing = this.watches.get(rootKey)
    if (existing) {
      existing.clients.set(clientId, isStale)
      if (watchId !== undefined) {
        existing.clientWatchIds.set(clientId, watchId)
      }
      await awaitRelayWatcherSetupForClient(existing, context, () =>
        this.releaseWatchClient(existing, clientId)
      )
      return
    }

    this.capacityGate.assert(rootKey)

    const state = createRelayWatcherState(rootKey, rootPath, clientId, isStale, watchId)
    this.watches.set(rootKey, state)
    state.setupWaiters = new PromiseSettlementWaiters(this.startInitialWatch(state))
    await awaitRelayWatcherSetupForClient(state, context, () =>
      this.releaseWatchClient(state, clientId)
    )
  }

  unwatch(rootPath: string, context?: RequestContext): void {
    const rootKey = normalizeRuntimePathForComparison(rootPath)
    const state = this.watches.get(rootKey)
    if (state) {
      this.releaseWatchClient(state, context?.clientId ?? 0)
      return
    }
    const setup = this.pendingSetups.get(rootKey)
    if (setup) {
      // Why: notification teardown must not disappear before async setup publishes ownership.
      void setup.promise.then(() => this.unwatch(rootPath, context)).catch(() => {})
    }
  }

  async unwatchAndWait(rootPath: string, context?: RequestContext): Promise<void> {
    const rootKey = normalizeRuntimePathForComparison(rootPath)
    let state = this.watches.get(rootKey)
    if (!state) {
      await this.pendingSetups.get(rootKey)?.promise.catch(() => undefined)
      state = this.watches.get(rootKey)
    }
    if (!state) {
      const failed = this.teardownTracker.failedState(rootKey)
      if (failed) {
        await this.closeWatch(failed)
        return
      }
      await this.teardownTracker.join(rootKey)
      return
    }
    const clientId = context?.clientId ?? 0
    for (const [registeredClientId, isStale] of state.clients) {
      if (registeredClientId !== clientId && isStale()) {
        state.clients.delete(registeredClientId)
        state.clientWatchIds.delete(registeredClientId)
      }
    }
    if ([...state.clients.keys()].some((registeredClientId) => registeredClientId !== clientId)) {
      // Why: destructive cleanup cannot acknowledge while another client owns the handle.
      throw new Error('Remote path is still watched by another client')
    }
    state.clients.delete(clientId)
    state.clientWatchIds.delete(clientId)
    await this.closeWatch(state)
  }

  async runWithRemovalFence<T>(rootPath: string, operation: () => Promise<T>): Promise<T> {
    return this.removalFence.run(normalizeRuntimePathForComparison(rootPath), operation)
  }

  beginWorktreePtySpawn(path: string): () => void {
    return this.removalFence.beginOperation(normalizeRuntimePathForComparison(path))
  }

  setWorktreePtyTeardown(teardown: (rootPath: string) => Promise<void>): void {
    this.removalFence.setBeforeRemove(teardown)
  }

  dispose(): void {
    this.disposed = true
    this.watches.forEach((state) => void this.closeWatch(state).catch(() => {}))
    this.watcherPool.dispose()
  }

  closeWatchesAndWait(): Promise<void> {
    this.disposed = true
    return closeRelayWatchesAndWait(
      this.watches,
      this.pendingSetups,
      this.teardownTracker,
      (state) => this.closeWatch(state)
    )
  }

  disposeAndWait = (): Promise<void> =>
    disposeRelayWatchesAndWait(() => this.closeWatchesAndWait(), this.watcherPool)

  private startInitialWatch(state: RelayWatcherTeardownState): Promise<void> {
    return startInitialRelayWatch(
      state,
      () => this.subscribeState(state),
      () => emitRelayWatcherOverflow(this.dispatcher, state.rootPath, state.closed),
      () => this.closeWatch(state)
    )
  }

  private subscribeState(state: RelayWatcherTeardownState): Promise<void> {
    const generation = ++state.generation
    const emitOverflow = (): void => {
      if (state.generation === generation) {
        emitRelayWatcherOverflow(this.dispatcher, state.rootPath, state.closed)
      }
    }
    return this.watcherPool
      .subscribe(
        state.rootPath,
        (error, events) => {
          if (state.closed || state.generation !== generation) {
            return
          }
          if (error) {
            process.stderr.write(
              `[relay] File watcher error for ${state.rootPath}: ${error.message}\n`
            )
            emitOverflow()
            return
          }
          emitRelayWatcherEvents(this.dispatcher, state.rootPath, state.closed, events)
        },
        RELAY_WATCH_OPTIONS,
        {
          delivery: { maxEventsPerBatch: MAX_BATCHED_WATCHER_EVENTS },
          onInterruption: emitOverflow,
          onOverflow: emitOverflow,
          onTerminalError: (error) => this.recoverWatch(state, generation, error),
          signal: state.abortController.signal,
          subscribeTimeoutMs: 60_000
        }
      )
      .then(async (subscription) => {
        if (
          state.closed ||
          state.generation !== generation ||
          this.watches.get(state.rootKey) !== state
        ) {
          if (state.closed) {
            state.subscription = subscription
          }
          await subscription.unsubscribe()
          if (state.subscription === subscription) {
            state.subscription = null
          }
          return
        }
        state.subscription = subscription
      })
  }

  private recoverWatch(
    state: RelayWatcherTeardownState,
    failedGeneration: number,
    error: Error
  ): void {
    if (state.closed || state.generation !== failedGeneration) {
      return
    }
    state.subscription = null
    emitRelayWatcherOverflow(this.dispatcher, state.rootPath, state.closed)
    const recovery = this.subscribeState(state)
    state.setupWaiters = new PromiseSettlementWaiters(recovery)
    void recovery.catch((recoveryError: unknown) => {
      if (!state.closed) {
        const message = recoveryError instanceof Error ? recoveryError.message : error.message
        process.stderr.write(
          `[relay] File watcher disabled after bounded recovery for ${state.rootPath}: ${message}\n`
        )
        emitRelayWatcherTerminalFailure(this.dispatcher, state, message)
        void this.closeWatch(state).catch(() => {})
      }
    })
  }

  private releaseClientWatches(clientId: number): void {
    this.watches.forEach((state) => this.releaseWatchClient(state, clientId))
  }

  private releaseWatchClient(state: RelayWatcherTeardownState, clientId: number): void {
    state.clients.delete(clientId)
    state.clientWatchIds.delete(clientId)
    if (!state.closed && state.clients.size === 0) {
      void this.closeWatch(state).catch(() => {})
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
