import type { FsChangeEvent } from '../../shared/types'
import {
  forgetRuntimeWatcherProcessRoot,
  resetRuntimeWatcherProcessForTest,
  subscribeViaRuntimeWatcherProcess,
  type WatcherProcessEvent,
  type WatcherProcessSubscription
} from '../ipc/parcel-watcher-process'
import { isWatcherProcessFailure } from '../ipc/parcel-watcher-process-failure'
import {
  WATCHER_IGNORE_DIRS,
  buildParcelWatcherIgnoreOptions
} from '../ipc/filesystem-watcher-ignore'

const RUNTIME_FILE_WATCH_IGNORE_OPTIONS = buildParcelWatcherIgnoreOptions(WATCHER_IGNORE_DIRS)
const RUNTIME_FILE_WATCH_EVENT_LIMIT = 200
const RUNTIME_FILE_WATCH_CRAWL_TIMEOUT_MS = 60_000

type RuntimeFileWatchSubscriber = {
  onEvents: (events: FsChangeEvent[]) => void
  onTerminalError: (error: Error) => void
}

type RuntimeRootWatch = {
  rootPath: string
  subscribers: Set<RuntimeFileWatchSubscriber>
  start: Promise<void>
  subscription: WatcherProcessSubscription | null
  abortController: AbortController
  generation: number
  closed: boolean
}

// Why: paired clients watching the same worktree share one native subscription.
// Different roots are assigned across the bounded crash-isolated child pool.
const runtimeRootWatches = new Map<string, RuntimeRootWatch>()

function overflowEvent(rootPath: string): FsChangeEvent[] {
  return [{ kind: 'overflow', absolutePath: rootPath }]
}

function mapWatcherEvents(events: readonly WatcherProcessEvent[]): FsChangeEvent[] {
  return events.map((event) => ({
    kind: event.type,
    absolutePath: event.path,
    isDirectory: event.isDirectory
  }))
}

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
  if (runtimeRootWatches.get(root.rootPath) === root) {
    runtimeRootWatches.delete(root.rootPath)
  }
  forgetRuntimeWatcherProcessRoot(root.rootPath)
  const subscribers = Array.from(root.subscribers)
  root.subscribers.clear()
  for (const subscriber of subscribers) {
    subscriber.onTerminalError(error)
  }
}

function closeInitialRootWatch(root: RuntimeRootWatch): void {
  root.closed = true
  root.generation++
  root.abortController.abort()
  if (runtimeRootWatches.get(root.rootPath) === root) {
    runtimeRootWatches.delete(root.rootPath)
  }
  forgetRuntimeWatcherProcessRoot(root.rootPath)
  root.subscribers.clear()
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

function subscribeRuntimeRootWatch(root: RuntimeRootWatch): Promise<void> {
  const generation = ++root.generation
  const emitOverflow = (): void => {
    if (root.generation === generation) {
      emitToSubscribers(root, overflowEvent(root.rootPath))
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
        emitOverflow()
        return
      }
      emitToSubscribers(root, mapWatcherEvents(events))
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
      // Why: the transport bounds initial setup at 15 seconds, but a later
      // crash-resubscribe has no request deadline and must not freeze its shard forever.
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
  try {
    await subscribeRuntimeRootWatch(root)
  } catch (firstError) {
    if (root.closed || !shouldRetryInitialWatch(firstError)) {
      closeInitialRootWatch(root)
      throw firstError
    }
    try {
      await subscribeRuntimeRootWatch(root)
      emitToSubscribers(root, overflowEvent(root.rootPath))
    } catch (isolatedError) {
      closeInitialRootWatch(root)
      throw isolatedError
    }
  }
}

function recoverRuntimeRootWatch(
  root: RuntimeRootWatch,
  failedGeneration: number,
  terminalError: Error
): void {
  if (root.closed || root.generation !== failedGeneration) {
    return
  }
  root.subscription = null
  emitToSubscribers(root, overflowEvent(root.rootPath))
  root.start = subscribeRuntimeRootWatch(root).catch((recoveryError: unknown) => {
    if (!root.closed) {
      terminateRootWatch(root, recoveryError instanceof Error ? recoveryError : terminalError)
    }
  })
}

function createRuntimeRootWatch(rootPath: string): RuntimeRootWatch {
  const root: RuntimeRootWatch = {
    rootPath,
    subscribers: new Set(),
    start: Promise.resolve(),
    subscription: null,
    abortController: new AbortController(),
    generation: 0,
    closed: false
  }
  runtimeRootWatches.set(rootPath, root)
  root.start = startInitialRuntimeRootWatch(root)
  return root
}

async function releaseRuntimeRootWatch(
  root: RuntimeRootWatch,
  subscriber: RuntimeFileWatchSubscriber
): Promise<void> {
  root.subscribers.delete(subscriber)
  if (root.closed || root.subscribers.size > 0) {
    return
  }
  root.closed = true
  root.generation++
  root.abortController.abort()
  if (runtimeRootWatches.get(root.rootPath) === root) {
    runtimeRootWatches.delete(root.rootPath)
  }
  await root.subscription?.unsubscribe()
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
  const root = runtimeRootWatches.get(rootPath) ?? createRuntimeRootWatch(rootPath)
  const subscriber: RuntimeFileWatchSubscriber = { onEvents: callback, onTerminalError }
  root.subscribers.add(subscriber)
  try {
    await waitForRuntimeRootStart(root, subscriber, signal)
  } catch (error) {
    root.subscribers.delete(subscriber)
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
    return root.start
  }
  if (signal.aborted) {
    void releaseRuntimeRootWatch(root, subscriber)
    return Promise.reject(new Error('file watcher subscription aborted'))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      signal.removeEventListener('abort', handleAbort)
      callback()
    }
    const handleAbort = (): void => {
      void releaseRuntimeRootWatch(root, subscriber)
      finish(() => reject(new Error('file watcher subscription aborted')))
    }
    signal.addEventListener('abort', handleAbort, { once: true })
    root.start.then(
      () => finish(resolve),
      (error: unknown) => finish(() => reject(error))
    )
  })
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
