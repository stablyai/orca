import { stat } from 'node:fs/promises'
import type { Event as WatcherEvent } from '@parcel/watcher'
import type { FsChangeEvent, FsChangedPayload } from '../../../../shared/filesystem-entry-types'
import { watchBatchFlushDelayMs } from '../../../../shared/filesystem-watch-batch-window'
import { MAX_BATCHED_WATCHER_EVENTS, queueWatcherEvents } from './filesystem-watcher-event-batch'
// Filter high-churn events at source; Explorer display filters only hide rows.
import { WATCHER_IGNORE_DIRS, buildParcelWatcherIgnoreOptions } from './filesystem-watcher-ignore'
import type { WatchedRoot } from './filesystem-watcher-wsl'
import { subscribeViaWatcherProcess } from '../watcher-process/parcel-watcher-process'
import { normalizeWatcherEventPath } from './filesystem-watcher-paths'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import {
  retainLocalWatcherPhysicalFailure,
  trackDetachedLocalUnsubscribe
} from './filesystem-watcher-listener-lifecycle'
import { cancelLocalBatchFlush, createDebouncedBatch } from './filesystem-watcher-batch-control'
import { mapWithConcurrency } from '../../../../shared/map-with-concurrency'
import {
  notifyLocalWatcherEvents,
  notifyLocalWatcherInterrupted
} from './local-watcher-event-observers'

// Match the watcher subprocess stat budget.
const DIRECTORY_STAT_CONCURRENCY = 8

// delete→create retains both for subtree/parent refresh; create→delete cancels within the window.
function coalesceEvents(
  raw: WatcherEvent[]
): { type: 'create' | 'update' | 'delete'; path: string }[] {
  const lastByPath = new Map<string, { type: 'create' | 'update' | 'delete'; index: number }>()
  const deleteBeforeCreate = new Set<string>()

  for (let i = 0; i < raw.length; i++) {
    const evt = raw[i]
    const p = normalizeWatcherEventPath(evt.path)
    const prev = lastByPath.get(p)

    if (prev) {
      if (prev.type === 'delete' && evt.type === 'create') {
        deleteBeforeCreate.add(p)
      }
      if (prev.type === 'create' && evt.type === 'delete') {
        lastByPath.delete(p)
        deleteBeforeCreate.delete(p)
        continue
      }
    }

    lastByPath.set(p, { type: evt.type, index: i })

    // Later events can supersede delete→create; do not retain its stale delete.
    if (evt.type !== 'create' && deleteBeforeCreate.has(p)) {
      deleteBeforeCreate.delete(p)
    }
  }

  const result: { type: 'create' | 'update' | 'delete'; path: string }[] = []

  for (const p of deleteBeforeCreate) {
    result.push({ type: 'delete', path: p })
  }

  for (const [p, entry] of lastByPath) {
    result.push({ type: entry.type, path: p })
  }

  return result
}

async function tryStatIsDirectory(filePath: string): Promise<boolean | undefined> {
  try {
    const s = await stat(filePath)
    return s.isDirectory()
  } catch {
    // Failed stat leaves the renderer's conservative file-event default.
    return undefined
  }
}

function emitOverflowPayload(root: WatchedRoot): void {
  const { rootPath } = root
  const payload: FsChangedPayload = {
    worktreePath: rootPath,
    events: [{ kind: 'overflow', absolutePath: rootPath }]
  }
  for (const [, wc] of root.listeners) {
    if (!wc.isDestroyed()) {
      wc.send('fs:changed', payload)
    }
  }
}

async function flushBatch(root: WatchedRoot): Promise<void> {
  if (root.batch.cancelled) {
    return
  }
  if (root.batch.flushInFlight) {
    root.batch.flushQueued = true
    return
  }

  root.batch.flushInFlight = true
  if (root.batch.timer) {
    clearTimeout(root.batch.timer)
    root.batch.timer = null
  }
  const overflowed = root.batch.overflowed
  const rawEvents = root.batch.events.splice(0)
  root.batch.overflowed = false
  root.batch.lastFlushAt = Date.now()

  try {
    if ((rawEvents.length === 0 && !overflowed) || root.listeners.size === 0) {
      return
    }

    if (overflowed || rawEvents.length > MAX_BATCHED_WATCHER_EVENTS) {
      // A large deletion storm needs one conservative refresh instead of per-path coalescing and stat.
      if (!root.batch.cancelled) {
        emitOverflowPayload(root)
      }
      return
    }

    const coalesced = coalesceEvents(rawEvents)

    // Bound stat concurrency so Git and persistence can still use libuv's shared pool.
    const events: FsChangeEvent[] = await mapWithConcurrency(
      coalesced,
      DIRECTORY_STAT_CONCURRENCY,
      async (evt) => {
        // Deleted paths cannot be statted; let the renderer infer from dirCache.
        const isDirectory =
          root.batch.cancelled || evt.type === 'delete'
            ? undefined
            : await tryStatIsDirectory(evt.path)

        return {
          kind: evt.type,
          absolutePath: evt.path,
          isDirectory
        }
      }
    )

    if (root.batch.cancelled || root.listeners.size === 0) {
      return
    }

    const payload: FsChangedPayload = {
      worktreePath: root.rootPath,
      events
    }

    for (const [, wc] of root.listeners) {
      if (!wc.isDestroyed()) {
        wc.send('fs:changed', payload)
      }
    }
  } finally {
    root.batch.flushInFlight = false
    if (root.batch.flushQueued) {
      root.batch.flushQueued = false
      if (
        !root.batch.cancelled &&
        // An armed flush still owns its window; draining early would split related events.
        !root.batch.timer &&
        (root.batch.events.length > 0 || root.batch.overflowed)
      ) {
        // Drain after the current payload settles to preserve event order and the storm tail.
        void flushBatch(root)
      }
    }
  }
}

export function scheduleLocalBatchFlush(root: WatchedRoot): void {
  if (root.batch.cancelled) {
    return
  }
  if (root.batch.flushInFlight) {
    root.batch.flushQueued = true
  }

  // Resetting armed timers would starve delivery under continuous writes.
  if (root.batch.timer) {
    return
  }
  // Null the fired timer so queued drain sees that the flush window closed.
  root.batch.timer = setTimeout(
    () => {
      root.batch.timer = null
      void flushBatch(root)
    },
    watchBatchFlushDelayMs(Date.now(), root.batch.lastFlushAt)
  )
}

export async function createLocalWatcher(
  rootKey: string,
  rootPath: string,
  signal?: AbortSignal
): Promise<WatchedRoot> {
  const root: WatchedRoot = {
    subscription: null!,
    listeners: new Map(),
    batch: createDebouncedBatch(),
    rootPath
  }

  try {
    // Errors can precede subscribe resolution; retain cleanup evidence to retire the orphan handle.
    let errorCleanedUp = false

    const watcherOptions = {
      ...buildParcelWatcherIgnoreOptions(WATCHER_IGNORE_DIRS),
      // Pin Windows backend to avoid Parcel's noisy Watchman probe.
      ...(process.platform === 'win32' ? { backend: 'windows' as const } : {})
    }

    const markWatcherInterrupted = (): void => {
      notifyLocalWatcherInterrupted(root)
      root.batch.overflowed = true
      scheduleLocalBatchFlush(root)
    }

    // Isolate watcher.node teardown crashes in a child; interruptions require overflow refresh (#7547).
    root.subscription = await subscribeViaWatcherProcess(
      rootPath,
      (err, events) => {
        if (err) {
          // Errors invalidate path precision; force a conservative renderer refresh.
          console.error(`[filesystem-watcher] error for ${rootKey}:`, err)
          notifyLocalWatcherInterrupted(root)
          emitOverflowPayload(root)
          // Retire native subscriptions that may be invalid after errors or root deletion.
          cancelLocalBatchFlush(root)
          // The error callback can precede assignment of the subscription.
          if (root.subscription) {
            retainLocalWatcherPhysicalFailure(rootKey, err)
            void trackDetachedLocalUnsubscribe(rootKey, root)
          }
          errorCleanedUp = true
          watcherLifecycleState.watchedRoots.delete(rootKey)
          return
        }

        if (root.batch.cancelled) {
          return
        }
        notifyLocalWatcherEvents(root, events)
        queueWatcherEvents(root.batch, events)
        scheduleLocalBatchFlush(root)
      },
      watcherOptions,
      {
        delivery: { maxEventsPerBatch: MAX_BATCHED_WATCHER_EVENTS },
        // A child restart or bounded-queue overflow loses path precision; both need the same conservative renderer refresh.
        onInterruption: markWatcherInterrupted,
        onOverflow: markWatcherInterrupted,
        signal
      }
    )

    // subscribe resolved after error cleanup; retire its orphaned native handle.
    if (errorCleanedUp) {
      void trackDetachedLocalUnsubscribe(rootKey, root)
      throw new Error(`Watcher for ${rootKey} errored during subscribe`)
    }
  } catch (err) {
    // Surface synchronous subscription failures through the caller rather than crashing main.
    console.error(`[filesystem-watcher] failed to subscribe ${rootKey}:`, err)
    throw err
  }

  return root
}
