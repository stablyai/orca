import type { RelayDispatcher, RequestContext } from './dispatcher'
import { MAX_BATCHED_WATCHER_EVENTS } from '../main/ipc/filesystem-watcher-event-batch'
import { isWatcherProcessFailure } from '../main/ipc/parcel-watcher-process-failure'
import type {
  WatcherProcessEvent,
  WatcherProcessSubscription
} from '../main/ipc/parcel-watcher-process'
import {
  WATCHER_IGNORE_DIRS,
  buildParcelWatcherIgnoreOptions
} from '../main/ipc/filesystem-watcher-ignore'
import {
  createRelayWatcherProcessPool,
  type RelayWatcherProcessPool
} from './relay-watcher-process-pool'

const MAX_RELAY_WATCH_ROOTS = 20
const RELAY_WATCH_CRAWL_TIMEOUT_MS = 60_000
const RELAY_WATCH_OPTIONS = buildParcelWatcherIgnoreOptions(WATCHER_IGNORE_DIRS)

type RelayWatchState = {
  rootPath: string
  clients: Map<number, () => boolean>
  setupPromise: Promise<void>
  subscription: WatcherProcessSubscription | null
  abortController: AbortController
  generation: number
  closed: boolean
}

function overflowEvent(rootPath: string): Record<string, unknown> {
  return { events: [{ kind: 'overflow', absolutePath: rootPath }] }
}

function createWatchAbortError(): Error {
  const error = new Error('Request "fs.watch" was cancelled')
  error.name = 'AbortError'
  return error
}

function shouldRetryInitialWatch(error: unknown): boolean {
  return (
    isWatcherProcessFailure(error) &&
    error.code !== 'entry_missing' &&
    error.code !== 'subscribe_aborted' &&
    error.code !== 'supervisor_disposed' &&
    (error.scope === 'supervisor' || error.code === 'subscribe_timeout')
  )
}

export class RelayFilesystemWatchRegistry {
  private readonly watches = new Map<string, RelayWatchState>()

  constructor(
    private readonly dispatcher: RelayDispatcher,
    private readonly watcherPool: RelayWatcherProcessPool = createRelayWatcherProcessPool()
  ) {
    this.dispatcher.onClientDetached?.((clientId) => this.releaseClientWatches(clientId))
  }

  async watch(rootPath: string, context?: RequestContext): Promise<void> {
    this.releaseStaleWatches()
    const clientId = context?.clientId ?? 0
    const isStale = context?.isStale ?? (() => false)
    const existing = this.watches.get(rootPath)
    if (existing) {
      existing.clients.set(clientId, isStale)
      await this.awaitSetupForClient(existing, clientId, context)
      return
    }

    if (this.watches.size >= MAX_RELAY_WATCH_ROOTS) {
      throw new Error('Maximum number of file watchers reached')
    }

    const state: RelayWatchState = {
      rootPath,
      clients: new Map([[clientId, isStale]]),
      setupPromise: Promise.resolve(),
      subscription: null,
      abortController: new AbortController(),
      generation: 0,
      closed: false
    }
    this.watches.set(rootPath, state)
    state.setupPromise = this.startInitialWatch(state)
    await this.awaitSetupForClient(state, clientId, context)
  }

  unwatch(rootPath: string, context?: RequestContext): void {
    const state = this.watches.get(rootPath)
    if (state) {
      this.releaseWatchClient(state, context?.clientId ?? 0)
    }
  }

  dispose(): void {
    for (const state of Array.from(this.watches.values())) {
      this.closeWatch(state)
    }
    this.watcherPool.dispose()
  }

  private async startInitialWatch(state: RelayWatchState): Promise<void> {
    try {
      await this.subscribeState(state)
    } catch (firstError) {
      if (!state.closed && shouldRetryInitialWatch(firstError)) {
        try {
          await this.subscribeState(state)
          this.emitOverflow(state)
          return
        } catch (quarantineError) {
          this.closeWatch(state)
          throw quarantineError
        }
      }
      this.closeWatch(state)
      throw firstError
    }
  }

  private subscribeState(state: RelayWatchState): Promise<void> {
    const generation = ++state.generation
    const emitOverflow = (): void => {
      if (state.generation === generation) {
        this.emitOverflow(state)
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
          this.emitEvents(state, events)
        },
        RELAY_WATCH_OPTIONS,
        {
          delivery: { maxEventsPerBatch: MAX_BATCHED_WATCHER_EVENTS },
          onInterruption: emitOverflow,
          onOverflow: emitOverflow,
          onTerminalError: (error) => this.recoverWatch(state, generation, error),
          signal: state.abortController.signal,
          subscribeTimeoutMs: RELAY_WATCH_CRAWL_TIMEOUT_MS
        }
      )
      .then(async (subscription) => {
        if (
          state.closed ||
          state.generation !== generation ||
          this.watches.get(state.rootPath) !== state
        ) {
          await subscription.unsubscribe()
          return
        }
        state.subscription = subscription
      })
  }

  private recoverWatch(state: RelayWatchState, failedGeneration: number, error: Error): void {
    if (state.closed || state.generation !== failedGeneration) {
      return
    }
    state.subscription = null
    this.emitOverflow(state)
    const recovery = this.subscribeState(state)
    state.setupPromise = recovery
    void recovery.catch((recoveryError: unknown) => {
      if (!state.closed) {
        const message = recoveryError instanceof Error ? recoveryError.message : error.message
        process.stderr.write(
          `[relay] File watcher disabled after bounded recovery for ${state.rootPath}: ${message}\n`
        )
        this.closeWatch(state)
      }
    })
  }

  private emitEvents(state: RelayWatchState, events: readonly WatcherProcessEvent[]): void {
    if (state.closed || events.length === 0) {
      return
    }
    this.dispatcher.notify('fs.changed', {
      events: events.map((event) => ({
        kind: event.type,
        absolutePath: event.path,
        ...(event.isDirectory === undefined ? {} : { isDirectory: event.isDirectory })
      }))
    })
  }

  private emitOverflow(state: RelayWatchState): void {
    if (!state.closed) {
      this.dispatcher.notify('fs.changed', overflowEvent(state.rootPath))
    }
  }

  private async awaitSetupForClient(
    state: RelayWatchState,
    clientId: number,
    context?: RequestContext
  ): Promise<void> {
    try {
      await this.awaitSetupWithAbort(state.setupPromise, context?.signal)
    } catch (error) {
      this.releaseWatchClient(state, clientId)
      const expectedAbort =
        (error instanceof Error && error.name === 'AbortError') ||
        (isWatcherProcessFailure(error) && error.code === 'subscribe_aborted')
      if (!expectedAbort && error instanceof Error) {
        process.stderr.write(
          `[relay] File watcher not available for ${state.rootPath}: ${error.message}\n`
        )
        throw error
      }
      return
    }
    if (context?.isStale()) {
      this.releaseWatchClient(state, clientId)
    }
  }

  private awaitSetupWithAbort(setupPromise: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      return setupPromise
    }
    if (signal.aborted) {
      return Promise.reject(createWatchAbortError())
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        cleanup()
        reject(createWatchAbortError())
      }
      const cleanup = (): void => signal.removeEventListener('abort', onAbort)
      signal.addEventListener('abort', onAbort, { once: true })
      setupPromise.then(
        () => {
          cleanup()
          resolve()
        },
        (error) => {
          cleanup()
          reject(error)
        }
      )
    })
  }

  private releaseClientWatches(clientId: number): void {
    for (const state of Array.from(this.watches.values())) {
      this.releaseWatchClient(state, clientId)
    }
  }

  private releaseStaleWatches(): void {
    for (const state of Array.from(this.watches.values())) {
      for (const [clientId, isStale] of state.clients) {
        if (isStale()) {
          state.clients.delete(clientId)
        }
      }
      if (state.clients.size === 0) {
        this.closeWatch(state)
      }
    }
  }

  private releaseWatchClient(state: RelayWatchState, clientId: number): void {
    state.clients.delete(clientId)
    if (!state.closed && state.clients.size === 0) {
      this.closeWatch(state)
    }
  }

  private closeWatch(state: RelayWatchState): void {
    if (state.closed) {
      return
    }
    state.closed = true
    state.generation++
    state.abortController.abort()
    state.clients.clear()
    if (this.watches.get(state.rootPath) === state) {
      this.watches.delete(state.rootPath)
    }
    const subscription = state.subscription
    state.subscription = null
    if (subscription) {
      // Why: a child can die during unwatch; release quarantine history even
      // when physical teardown reports that already-contained failure.
      void subscription.unsubscribe().then(
        () => this.watcherPool.forgetRoot(state.rootPath),
        () => this.watcherPool.forgetRoot(state.rootPath)
      )
      return
    }
    void state.setupPromise.then(
      () => this.watcherPool.forgetRoot(state.rootPath),
      () => this.watcherPool.forgetRoot(state.rootPath)
    )
  }
}
