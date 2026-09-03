import { stat } from 'node:fs/promises'
import type { Event as WatcherEvent } from '@parcel/watcher'
import type { FsChangeEvent, FsChangedPayload } from '../../shared/filesystem-entry-types'
import {
  WATCH_BATCH_MAX_WAIT_MS,
  WATCH_BATCH_TRAILING_MS
} from '../../shared/filesystem-watch-batch-window'
import { MAX_BATCHED_WATCHER_EVENTS, queueWatcherEvents } from './filesystem-watcher-event-batch'
// Why: suppress high-churn dirs at the watcher level (separate from the File Explorer display filter, which only hides rows).
import { WATCHER_IGNORE_DIRS, buildParcelWatcherIgnoreOptions } from './filesystem-watcher-ignore'
import type { WatchedRoot } from './filesystem-watcher-wsl'
import { subscribeViaWatcherProcess } from './parcel-watcher-process'
import { normalizeWatcherEventPath } from './filesystem-watcher-paths'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import {
  retainLocalWatcherPhysicalFailure,
  trackDetachedLocalUnsubscribe
} from './filesystem-watcher-listener-lifecycle'
import { createDebouncedBatch } from './filesystem-watcher-batch-control'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'

// Why: matches the watcher subprocess budget in parcel-watcher-event-delivery.ts.
const DIRECTORY_STAT_CONCURRENCY = 8

// ── Event coalescing ─────────────────────────────────────────────────
// Why: keep the last event per path in a flush window; delete→create emits both (delete cleans the subtree, create refreshes the parent), create→delete is dropped (§4.4).
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
      // delete followed by create → emit both
      if (prev.type === 'delete' && evt.type === 'create') {
        deleteBeforeCreate.add(p)
      }
      // create followed by delete → net no-op, remove both
      if (prev.type === 'create' && evt.type === 'delete') {
        lastByPath.delete(p)
        deleteBeforeCreate.delete(p)
        continue
      }
    }

    lastByPath.set(p, { type: evt.type, index: i })

    // Why: drop the stale delete when a later event supersedes delete→create, else output has a spurious delete for a file that still exists (§4.4).
    if (evt.type !== 'create' && deleteBeforeCreate.has(p)) {
      deleteBeforeCreate.delete(p)
    }
  }

  const result: { type: 'create' | 'update' | 'delete'; path: string }[] = []

  // Emit delete events first for paths that have delete→create
  for (const p of deleteBeforeCreate) {
    result.push({ type: 'delete', path: p })
  }

  // Emit the last event for each path
  for (const [p, entry] of lastByPath) {
    result.push({ type: entry.type, path: p })
  }

  return result
}

// ── Stat helper for isDirectory ──────────────────────────────────────

async function tryStatIsDirectory(filePath: string): Promise<boolean | undefined> {
  try {
    const s = await stat(filePath)
    return s.isDirectory()
  } catch {
    // Why: stat failure (EPERM, vanished file) → undefined; renderer treats it as a file event, the safe default (§4.4).
    return undefined
  }
}

// ── Flush and emit ───────────────────────────────────────────────────

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
  root.batch.firstEventAt = 0

  try {
    if ((rawEvents.length === 0 && !overflowed) || root.listeners.size === 0) {
      return
    }

    if (overflowed || rawEvents.length > MAX_BATCHED_WATCHER_EVENTS) {
      // Why: deletion storms can be too large to coalesce/stat per path; one overflow asks the renderer for the same conservative refresh.
      if (!root.batch.cancelled) {
        emitOverflowPayload(root)
      }
      return
    }

    const coalesced = coalesceEvents(rawEvents)

    // Why: a full batch is up to MAX_BATCHED_WATCHER_EVENTS paths; unbounded stat() would swamp
    // libuv's 4-thread pool, which also serves git reads and persistence writes.
    const events: FsChangeEvent[] = await mapWithConcurrency(
      coalesced,
      DIRECTORY_STAT_CONCURRENCY,
      async (evt) => {
        // Why: a deleted path can't be stat'd; leave isDirectory undefined and let the renderer infer from dirCache.
        const isDirectory = evt.type === 'delete' ? undefined : await tryStatIsDirectory(evt.path)

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
        // Why: an armed timer still owns its debounce window; draining here would split related events across payloads.
        !root.batch.timer &&
        (root.batch.events.length > 0 || root.batch.overflowed)
      ) {
        // Drain the queued batch only after the current payload has settled,
        // preserving watcher event ordering without dropping a storm tail.
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

  const now = Date.now()

  if (root.batch.firstEventAt === 0) {
    root.batch.firstEventAt = now
  }

  // If we've exceeded the max wait, flush immediately
  if (now - root.batch.firstEventAt >= WATCH_BATCH_MAX_WAIT_MS) {
    if (root.batch.timer) {
      clearTimeout(root.batch.timer)
      root.batch.timer = null
    }
    void flushBatch(root)
    return
  }

  // Trailing-edge debounce: reset timer on each new event
  if (root.batch.timer) {
    clearTimeout(root.batch.timer)
  }
  // Why: clear the handle as it fires so `batch.timer` means "a debounce window is still open", which gates the queued drain.
  root.batch.timer = setTimeout(() => {
    root.batch.timer = null
    void flushBatch(root)
  }, WATCH_BATCH_TRAILING_MS)
}

// ── Watcher creation ─────────────────────────────────────────────────

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
    // Why: if the error callback cleaned up before subscribe() resolved, its returned subscription is orphaned and leaks a native handle.
    let errorCleanedUp = false

    const watcherOptions = {
      ...buildParcelWatcherIgnoreOptions(WATCHER_IGNORE_DIRS),
      // Why: Parcel probes Watchman first, which prints a shell-level "watchman not recognized" error on Windows; pin the backend to suppress it.
      ...(process.platform === 'win32' ? { backend: 'windows' as const } : {})
    }

    const markWatcherInterrupted = (): void => {
      root.batch.overflowed = true
      scheduleLocalBatchFlush(root)
    }

    // Why: fork the watcher process (issue #7547 — watcher.node teardown races crash the host); onInterruption marks overflow to refresh past the gap.
    root.subscription = await subscribeViaWatcherProcess(
      rootPath,
      (err, events) => {
        if (err) {
          // Why: treat watcher errors as overflow so the renderer conservatively refreshes rather than trusting possibly-invalid caches (§7.2, §7.3).
          console.error(`[filesystem-watcher] error for ${rootKey}:`, err)
          emitOverflowPayload(root)
          // Why: after an error the native subscription may be invalid (deleted root); tear down the dead watcher so it doesn't dangle (§7.3).
          if (root.batch.timer) {
            clearTimeout(root.batch.timer)
          }
          // Why: error callback can fire before subscribe() assigns root.subscription; guard against null so cleanup doesn't crash.
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

    // Why: error callback already cleaned up watchedRoots before subscribe() resolved; unsubscribe this orphaned subscription so it doesn't leak.
    if (errorCleanedUp) {
      void trackDetachedLocalUnsubscribe(rootKey, root)
      throw new Error(`Watcher for ${rootKey} errored during subscribe`)
    }
  } catch (err) {
    // Why: watcher backend can throw synchronously on a deleted root/permission error; log rather than crash the main process (§7.3).
    console.error(`[filesystem-watcher] failed to subscribe ${rootKey}:`, err)
    throw err
  }

  return root
}
