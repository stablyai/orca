import { ipcMain, type WebContents } from 'electron'
import * as path from 'path'
import { stat } from 'fs/promises'
import type { Event as WatcherEvent } from '@parcel/watcher'
import type { FsChangeEvent, FsChangedPayload } from '../../shared/types'
import { isWslPath } from '../wsl'
import { createWslWatcher } from './filesystem-watcher-wsl'
import type { WatchedRoot } from './filesystem-watcher-wsl'

// ── Ignore patterns ──────────────────────────────────────────────────
// Why: high-churn directories are suppressed at the native watcher level
// so events never leave the OS kernel. This list is separate from the
// File Explorer display filter (which only hides rows). Directories like
// `dist` and `build` remain visible in the tree but will not auto-refresh.

const WATCHER_IGNORE_DIRS: string[] = [
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache',
  '__pycache__',
  'target',
  '.venv'
]

// ── Debounce helpers ─────────────────────────────────────────────────

const DEBOUNCE_TRAILING_MS = 150
const DEBOUNCE_MAX_WAIT_MS = 500

// ── Per-root watcher state ───────────────────────────────────────────
// WatchedRoot and WatcherSubscription are defined in filesystem-watcher-wsl.ts
// and re-used here so both native and WSL watchers share the same shape.

// ── Module state ─────────────────────────────────────────────────────

const watchedRoots = new Map<string, WatchedRoot>()

// Why: roots that failed watcher creation (e.g. WSL UNC paths where
// @parcel/watcher's ReadDirectoryChangesW doesn't work) are cached so
// we don't retry on every worktree switch and spam the console with
// repeated "Failed to read changes" / "watchman not found" errors.
const unwatchableRoots = new Set<string>()

// Why: the `destroyed` listener was previously registered per-root on the
// same WebContents.  With 11+ worktrees, this exceeded Node's default
// MaxListeners of 10.  Track which senders already have a single cleanup
// listener so we register exactly once per sender.
const senderCleanupRegistered = new Set<number>()

// ── Path normalization ───────────────────────────────────────────────

function normalizeRootPath(rootPath: string): string {
  let resolved = path.resolve(rootPath)
  // Why: on Windows, watcher events may report lowercase drive letters while
  // stored worktree paths use uppercase. Normalizing here ensures the renderer's
  // POSIX normalization produces casing-consistent results (see design §4.4).
  if (/^[a-zA-Z]:/.test(resolved)) {
    resolved = resolved.charAt(0).toUpperCase() + resolved.slice(1)
  }
  return resolved
}

function normalizeEventPath(eventPath: string): string {
  let resolved = path.resolve(eventPath)
  if (/^[a-zA-Z]:/.test(resolved)) {
    resolved = resolved.charAt(0).toUpperCase() + resolved.slice(1)
  }
  return resolved
}

// ── Event coalescing ─────────────────────────────────────────────────
// Why: within a single flush window the same path can appear multiple times.
// Keep the last event per path, except: delete→create emits both (the delete
// triggers subtree cleanup, the create triggers parent refresh); create→delete
// is dropped entirely (net no-op). See design §4.4.

function coalesceEvents(
  raw: WatcherEvent[]
): { type: 'create' | 'update' | 'delete'; path: string }[] {
  const lastByPath = new Map<string, { type: 'create' | 'update' | 'delete'; index: number }>()
  const deleteBeforeCreate = new Set<string>()

  for (let i = 0; i < raw.length; i++) {
    const evt = raw[i]
    const p = normalizeEventPath(evt.path)
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

    // Why: if a later event (e.g. update) supersedes a delete→create sequence,
    // the stale delete must be dropped. Otherwise the final output would include
    // a spurious delete + the new event type (e.g. delete→create→update would
    // emit delete+update, but the file exists so the delete is wrong). See §4.4.
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
    // Why: if stat fails (EPERM, vanished temp file), return undefined.
    // The renderer treats undefined the same as a file event (parent-only
    // invalidation), which is the safe default. See design §4.4.
    return undefined
  }
}

// ── Flush and emit ───────────────────────────────────────────────────

async function flushBatch(rootKey: string, root: WatchedRoot): Promise<void> {
  const rawEvents = root.batch.events.splice(0)
  root.batch.timer = null
  root.batch.firstEventAt = 0

  if (rawEvents.length === 0 || root.listeners.size === 0) {
    return
  }

  const coalesced = coalesceEvents(rawEvents)

  // Build the payload with isDirectory info
  const events: FsChangeEvent[] = await Promise.all(
    coalesced.map(async (evt) => {
      // Why: for delete events the path no longer exists on disk, so stat is
      // not possible. Set isDirectory to undefined and let the renderer infer
      // from dirCache (if the deleted path is a dirCache key, it's a directory).
      const isDirectory = evt.type === 'delete' ? undefined : await tryStatIsDirectory(evt.path)

      return {
        kind: evt.type,
        absolutePath: evt.path,
        isDirectory
      }
    })
  )

  const payload: FsChangedPayload = {
    worktreePath: rootKey,
    events
  }

  for (const [, wc] of root.listeners) {
    if (!wc.isDestroyed()) {
      wc.send('fs:changed', payload)
    }
  }
}

function scheduleBatchFlush(rootKey: string, root: WatchedRoot): void {
  const now = Date.now()

  if (root.batch.firstEventAt === 0) {
    root.batch.firstEventAt = now
  }

  // If we've exceeded the max wait, flush immediately
  if (now - root.batch.firstEventAt >= DEBOUNCE_MAX_WAIT_MS) {
    if (root.batch.timer) {
      clearTimeout(root.batch.timer)
    }
    void flushBatch(rootKey, root)
    return
  }

  // Trailing-edge debounce: reset timer on each new event
  if (root.batch.timer) {
    clearTimeout(root.batch.timer)
  }
  root.batch.timer = setTimeout(() => void flushBatch(rootKey, root), DEBOUNCE_TRAILING_MS)
}

// ── Watcher creation ─────────────────────────────────────────────────

async function createWatcher(rootKey: string, rootPath: string): Promise<WatchedRoot> {
  // Why: @parcel/watcher is a native module that may not load in all
  // environments. Dynamic import keeps the require() lazy.
  const watcher = await import('@parcel/watcher')

  const root: WatchedRoot = {
    subscription: null!,
    listeners: new Map(),
    batch: { events: [], timer: null, firstEventAt: 0 }
  }

  try {
    // Why: track whether the error callback already ran cleanup before
    // subscribe() resolved.  If it did, the subscription object returned
    // by subscribe() would be orphaned (never stored in watchedRoots and
    // therefore never unsubscribed), leaking a native file-watcher handle.
    let errorCleanedUp = false

    root.subscription = await watcher.subscribe(
      rootPath,
      (err, events) => {
        if (err) {
          // Why: watcher errors (including watched-root deletion) are treated
          // as overflow so the renderer conservatively refreshes all visible
          // tree state rather than trusting possibly-invalid caches (§7.2, §7.3).
          console.error(`[filesystem-watcher] error for ${rootKey}:`, err)
          const overflowPayload: FsChangedPayload = {
            worktreePath: rootKey,
            events: [{ kind: 'overflow', absolutePath: rootKey }]
          }
          for (const [, wc] of root.listeners) {
            if (!wc.isDestroyed()) {
              wc.send('fs:changed', overflowPayload)
            }
          }
          // Why: after a watcher error the native subscription may be invalid
          // (e.g. watched root was deleted). Tear down the dead watcher so we
          // don't leave a dangling subscription for a root that no longer
          // exists on disk (§7.3).
          if (root.batch.timer) {
            clearTimeout(root.batch.timer)
          }
          // Why: the error callback can fire before `watcher.subscribe()`
          // resolves and assigns root.subscription (e.g. the watched root
          // is deleted or inaccessible at startup).  Guard against null so
          // the cleanup path doesn't crash the main process.
          if (root.subscription) {
            void root.subscription.unsubscribe().catch(() => {
              // Already errored — ignore cleanup failures
            })
          }
          errorCleanedUp = true
          watchedRoots.delete(rootKey)
          return
        }

        root.batch.events.push(...events)
        scheduleBatchFlush(rootKey, root)
      },
      {
        ignore: WATCHER_IGNORE_DIRS
      }
    )

    // Why: if the error callback already fired and cleaned up watchedRoots
    // before subscribe() resolved, the subscription we just received is
    // orphaned.  Unsubscribe it immediately to avoid leaking a native
    // file-watcher handle that no code path would ever clean up.
    if (errorCleanedUp) {
      void root.subscription.unsubscribe().catch(() => {})
      throw new Error(`Watcher for ${rootKey} errored during subscribe`)
    }
  } catch (err) {
    // Why: if the watcher backend throws synchronously on a deleted root
    // or permission error, log rather than crashing the main process (§7.3).
    console.error(`[filesystem-watcher] failed to subscribe ${rootKey}:`, err)
    throw err
  }

  return root
}

// ── Subscribe / Unsubscribe ──────────────────────────────────────────

async function subscribe(worktreePath: string, sender: WebContents): Promise<void> {
  const rootKey = normalizeRootPath(worktreePath)

  // Don't retry roots that already failed — avoids repeated error spam.
  if (unwatchableRoots.has(rootKey)) {
    return
  }

  let root = watchedRoots.get(rootKey)
  if (!root) {
    // Verify root exists and is a directory
    try {
      const s = await stat(rootKey)
      if (!s.isDirectory()) {
        console.warn(`[filesystem-watcher] not a directory: ${rootKey}`)
        unwatchableRoots.add(rootKey)
        return
      }
    } catch {
      console.warn(`[filesystem-watcher] cannot stat root: ${rootKey}`)
      unwatchableRoots.add(rootKey)
      return
    }

    try {
      // Why: WSL paths use inotifywait inside the Linux distro where
      // inotify works natively; native Windows paths use @parcel/watcher.
      root = isWslPath(worktreePath)
        ? await createWslWatcher(rootKey, worktreePath, {
            ignoreDirs: WATCHER_IGNORE_DIRS,
            scheduleBatchFlush,
            watchedRoots
          })
        : await createWatcher(rootKey, rootKey)
    } catch {
      // Why: createWatcher / createWslWatcher already logged the error.
      // Swallow it here so the renderer's watchWorktree call resolves
      // without crashing the main process.
      unwatchableRoots.add(rootKey)
      return
    }
    watchedRoots.set(rootKey, root)
  }

  root.listeners.set(sender.id, sender)

  // Why: register a single `destroyed` listener per sender (not per-root).
  // The old code registered one listener per root, so 11+ worktrees would
  // exceed Node's default MaxListeners of 10 on the same WebContents.  A
  // single listener that iterates all roots avoids the warning and is
  // equivalent — `destroyed` fires once when the renderer process exits.
  if (!senderCleanupRegistered.has(sender.id)) {
    senderCleanupRegistered.add(sender.id)
    sender.once('destroyed', () => {
      senderCleanupRegistered.delete(sender.id)
      for (const [key, watchedRoot] of watchedRoots) {
        if (watchedRoot.listeners.has(sender.id)) {
          watchedRoot.listeners.delete(sender.id)
          if (watchedRoot.listeners.size === 0) {
            if (watchedRoot.batch.timer) {
              clearTimeout(watchedRoot.batch.timer)
            }
            void watchedRoot.subscription.unsubscribe().catch((err: unknown) => {
              console.error(`[filesystem-watcher] unsubscribe error for ${key}:`, err)
            })
            watchedRoots.delete(key)
          }
        }
      }
    })
  }
}

function unsubscribe(worktreePath: string, senderId: number): void {
  const rootKey = normalizeRootPath(worktreePath)
  const root = watchedRoots.get(rootKey)
  if (!root) {
    return
  }

  root.listeners.delete(senderId)

  // Tear down the watcher when the last subscriber leaves
  if (root.listeners.size === 0) {
    if (root.batch.timer) {
      clearTimeout(root.batch.timer)
    }
    void root.subscription.unsubscribe().catch((err: unknown) => {
      console.error(`[filesystem-watcher] unsubscribe error for ${rootKey}:`, err)
    })
    watchedRoots.delete(rootKey)
  }
}

// ── Public API ───────────────────────────────────────────────────────

export function registerFilesystemWatcherHandlers(): void {
  ipcMain.handle(
    'fs:watchWorktree',
    async (event, args: { worktreePath: string }): Promise<void> => {
      await subscribe(args.worktreePath, event.sender)
    }
  )

  ipcMain.handle('fs:unwatchWorktree', (_event, args: { worktreePath: string }): void => {
    const senderId = _event.sender.id
    unsubscribe(args.worktreePath, senderId)
  })
}

/** Tear down all watchers on app shutdown. */
export async function closeAllWatchers(): Promise<void> {
  for (const [rootKey, root] of watchedRoots) {
    if (root.batch.timer) {
      clearTimeout(root.batch.timer)
    }
    try {
      await root.subscription.unsubscribe()
    } catch (err) {
      console.error(`[filesystem-watcher] shutdown unsubscribe error for ${rootKey}:`, err)
    }
  }
  watchedRoots.clear()
}
