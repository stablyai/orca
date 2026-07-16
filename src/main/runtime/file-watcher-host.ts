import type { FsChangeEvent } from '../../shared/types'
import {
  forgetRuntimeWatcherProcessRoot,
  resetRuntimeWatcherProcessForTest,
  subscribeViaRuntimeWatcherProcess,
  type WatcherProcessSubscription
} from '../ipc/parcel-watcher-process'
import type { WatcherProcessFailure } from '../ipc/parcel-watcher-process-failure'
import {
  WATCHER_IGNORE_DIRS,
  buildParcelWatcherIgnoreOptions
} from '../ipc/filesystem-watcher-ignore'
import { createRuntimeRootOwnershipReleaser } from './runtime-root-watch-ownership'
import { closeRuntimeRootWatch } from './runtime-root-watch-teardown'
import {
  RUNTIME_FILE_WATCH_CRAWL_TIMEOUT_MS,
  RUNTIME_FILE_WATCH_MAX_SETUP_ATTEMPTS
} from '../../shared/runtime-file-watch-limits'
import { PromiseSettlementWaiters } from '../../shared/promise-settlement-waiters'
import { mapRuntimeFileWatchEvents, runtimeFileWatchOverflow } from './runtime-file-watch-events'
import { startWatcherGenerationReplacement } from '../../shared/watcher-generation-replacement'
import { shouldRetryInitialRuntimeWatch } from './runtime-file-watch-setup-retry'

const RUNTIME_FILE_WATCH_IGNORE_OPTIONS = buildParcelWatcherIgnoreOptions(WATCHER_IGNORE_DIRS)
const RUNTIME_FILE_WATCH_EVENT_LIMIT = 200

type RuntimeFileWatchSubscriber = {
  onEvents: (events: FsChangeEvent[]) => void
  onTerminalError: (error: Error) => void
}

type RuntimeRootWatch = {
  rootPath: string
  subscribers: Set<RuntimeFileWatchSubscriber>
  startWaiters: PromiseSettlementWaiters<void>
  subscription: WatcherProcessSubscription | null
  abortController: AbortController
  generation: number
  closed: boolean
  closePromise: Promise<void> | null
  terminalReleaseError: WatcherProcessFailure | null
}

// Why: paired clients watching the same worktree share one native subscription.
// Different roots are assigned across the bounded crash-isolated child pool.
const runtimeRootWatches = new Map<string, RuntimeRootWatch>()
const {
  release: releaseRuntimeRootOwnership,
  releaseAfterFailure: releaseRuntimeRootAfterFailure
} = createRuntimeRootOwnershipReleaser(runtimeRootWatches, forgetRuntimeWatcherProcessRoot)

function emitToSubscribers(root: RuntimeRootWatch, events: FsChangeEvent[]): void {
  if (root.closed) {
    return
  }
  for (const subscriber of root.subscribers) {
    subscriber.onEvents(events)
  }
}

function terminateRootWatch(root: RuntimeRootWatch, error: Error): void {
  if (root.closed) {
    return
  }
  root.closed = true
  root.generation++
  root.abortController.abort()
  releaseRuntimeRootAfterFailure(root, error)
  const subscribers = Array.from(root.subscribers)
  root.subscribers.clear()
  for (const subscriber of subscribers) {
    subscriber.onTerminalError(error)
  }
}

function closeInitialRootWatch(root: RuntimeRootWatch, error: unknown): void {
  root.closed = true
  root.generation++
  root.abortController.abort()
  releaseRuntimeRootAfterFailure(
    root,
    error instanceof Error ? error : new Error('file watcher setup failed')
  )
  root.subscribers.clear()
}
function subscribeRuntimeRootWatch(
  root: RuntimeRootWatch,
  generation = ++root.generation
): Promise<void> {
  const emitOverflow = (): void => {
    if (root.generation === generation) {
      emitToSubscribers(root, runtimeFileWatchOverflow(root.rootPath))
    }
  }
  return subscribeViaRuntimeWatcherProcess(
    root.rootPath,
    (err, events) => {
      if (root.generation !== generation || root.closed) {
        return
      }
      if (err) {
        console.error('[runtime-files.watch] watcher error', {
          rootPath: root.rootPath,
          error: err.message
        })
        // Why: callback errors mean the native subscription is untrustworthy; overflow has its own hook.
        recoverRuntimeRootWatch(root, generation, err, true)
        return
      }
      emitToSubscribers(root, mapRuntimeFileWatchEvents(events))
    },
    RUNTIME_FILE_WATCH_IGNORE_OPTIONS,
    {
      delivery: {
        includeDirectoryMetadata: true,
        maxEventsPerBatch: RUNTIME_FILE_WATCH_EVENT_LIMIT
      },
      onInterruption: emitOverflow,
      onOverflow: emitOverflow,
      onTerminalError: (error) => recoverRuntimeRootWatch(root, generation, error),
      // Why: later crash-resubscribe needs a deadline independent of initial setup.
      subscribeTimeoutMs: RUNTIME_FILE_WATCH_CRAWL_TIMEOUT_MS,
      signal: root.abortController.signal
    }
  ).then(async (subscription) => {
    if (root.closed || root.generation !== generation) {
      await subscription.unsubscribe()
      return
    }
    root.subscription = subscription
  })
}
async function startInitialRuntimeRootWatch(root: RuntimeRootWatch): Promise<void> {
  for (let attempt = 0; attempt < RUNTIME_FILE_WATCH_MAX_SETUP_ATTEMPTS; attempt++) {
    try {
      await subscribeRuntimeRootWatch(root)
      if (attempt > 0) {
        emitToSubscribers(root, runtimeFileWatchOverflow(root.rootPath))
      }
      return
    } catch (error) {
      if (
        root.closed ||
        attempt + 1 >= RUNTIME_FILE_WATCH_MAX_SETUP_ATTEMPTS ||
        !shouldRetryInitialRuntimeWatch(error)
      ) {
        closeInitialRootWatch(root, error)
        throw error
      }
    }
  }
}
function recoverRuntimeRootWatch(
  root: RuntimeRootWatch,
  failedGeneration: number,
  terminalError: Error,
  releaseFailedSubscription = false
): void {
  const replacement = startWatcherGenerationReplacement(
    root,
    failedGeneration,
    () => {
      const failedSubscription = releaseFailedSubscription ? root.subscription : null
      root.subscription = null
      emitToSubscribers(root, runtimeFileWatchOverflow(root.rootPath))
      return failedSubscription ? () => failedSubscription.unsubscribe() : undefined
    },
    (generation) => subscribeRuntimeRootWatch(root, generation)
  )
  if (!replacement) {
    return
  }
  const recovery = replacement.promise.catch((recoveryError: unknown) => {
    if (root.closed) {
      throw recoveryError
    }
    if (root.generation !== replacement.generation) {
      return
    }
    terminateRootWatch(root, recoveryError instanceof Error ? recoveryError : terminalError)
  })
  root.startWaiters = new PromiseSettlementWaiters(recovery)
}

function createRuntimeRootWatch(rootPath: string): RuntimeRootWatch {
  const root: RuntimeRootWatch = {
    rootPath,
    subscribers: new Set(),
    startWaiters: new PromiseSettlementWaiters(Promise.resolve()),
    subscription: null,
    abortController: new AbortController(),
    generation: 0,
    closed: false,
    closePromise: null,
    terminalReleaseError: null
  }
  runtimeRootWatches.set(rootPath, root)
  root.startWaiters = new PromiseSettlementWaiters(startInitialRuntimeRootWatch(root))
  return root
}

async function releaseRuntimeRootWatch(
  root: RuntimeRootWatch,
  subscriber: RuntimeFileWatchSubscriber
): Promise<void> {
  root.subscribers.delete(subscriber)
  if (root.closed) {
    if (root.closePromise) {
      await root.closePromise
    }
    if (root.terminalReleaseError) {
      throw root.terminalReleaseError
    }
    return
  }
  if (root.subscribers.size > 0) {
    return
  }
  await closeRuntimeRootWatchOnce(root)
}

function closeRuntimeRootWatchOnce(root: RuntimeRootWatch): Promise<void> {
  root.closePromise ??= closeRuntimeRootWatch(
    root,
    root.startWaiters.promise,
    () => releaseRuntimeRootOwnership(root),
    (error) => releaseRuntimeRootAfterFailure(root, error)
  )
  return root.closePromise
}

export async function closeFileExplorerWatcherInWatcherProcess(rootPath: string): Promise<void> {
  const root = runtimeRootWatches.get(rootPath)
  if (!root) {
    return
  }
  // Why: destructive cleanup owns every same-root subscriber, including a
  // setup that failed before it could publish an unsubscribe callback.
  root.subscribers.clear()
  await closeRuntimeRootWatchOnce(root)
}

/**
 * Start a recursive runtime-file watch in the crash-isolated process pool.
 * The child owns crawl, event collapse, and stat metadata so neither native
 * faults nor event storms can consume the serve process's libuv pool.
 */
export async function watchFileExplorerInWatcherProcess(
  rootPath: string,
  callback: (events: FsChangeEvent[]) => void,
  onTerminalError: (error: Error) => void = () => undefined,
  signal?: AbortSignal
): Promise<() => Promise<void>> {
  const existingRoot = runtimeRootWatches.get(rootPath)
  if (existingRoot?.closed) {
    if (!existingRoot.closePromise) {
      throw existingRoot.terminalReleaseError ?? new Error('file watcher closed during setup')
    }
    // Why: a replacement cannot share a native root whose prior generation
    // is still closing; join its exact release before creating the next owner.
    await existingRoot.closePromise
    if (signal?.aborted) {
      throw createRuntimeRootAbortError()
    }
    return watchFileExplorerInWatcherProcess(rootPath, callback, onTerminalError, signal)
  }
  const root = existingRoot ?? createRuntimeRootWatch(rootPath)
  const subscriber: RuntimeFileWatchSubscriber = { onEvents: callback, onTerminalError }
  root.subscribers.add(subscriber)
  try {
    await waitForRuntimeRootStart(root, subscriber, signal)
  } catch (error) {
    // Why: paired unwatch cannot acknowledge until native cancellation or
    // physical exit releases this root for an immediate replacement watch.
    await releaseRuntimeRootWatch(root, subscriber)
    throw error
  }
  if (root.closed) {
    throw new Error('file watcher closed during setup')
  }

  let releasePromise: Promise<void> | undefined
  return (): Promise<void> => {
    releasePromise ??= releaseRuntimeRootWatch(root, subscriber)
    return releasePromise
  }
}

function waitForRuntimeRootStart(
  root: RuntimeRootWatch,
  subscriber: RuntimeFileWatchSubscriber,
  signal: AbortSignal | undefined
): Promise<void> {
  if (!signal) {
    return root.startWaiters.promise
  }
  if (signal.aborted) {
    root.subscribers.delete(subscriber)
    return Promise.reject(new Error('file watcher subscription aborted'))
  }
  return root.startWaiters.wait({
    signal,
    createAbortError: createRuntimeRootAbortError,
    onAbandon: () => root.subscribers.delete(subscriber)
  })
}

function createRuntimeRootAbortError(): Error {
  return new Error('file watcher subscription aborted')
}

export function resetRuntimeRootWatchersForTest(): void {
  for (const root of runtimeRootWatches.values()) {
    root.closed = true
    root.generation++
    root.abortController.abort()
    root.subscribers.clear()
    void root.subscription?.unsubscribe()
  }
  runtimeRootWatches.clear()
  resetRuntimeWatcherProcessForTest()
}

export function getRuntimeRootWatchWaiterCountForTest(rootPath: string): number {
  return runtimeRootWatches.get(rootPath)?.startWaiters.waiterCount ?? 0
}
