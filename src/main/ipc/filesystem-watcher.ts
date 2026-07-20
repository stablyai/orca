/* eslint-disable max-lines -- Why: one module keeps native (@parcel/watcher), WSL-snapshot, and SSH watcher lifecycle invariants and shared debounce/coalesce helpers auditable in one file. */
import { ipcMain, type WebContents } from 'electron'
import * as path from 'node:path'
import { stat } from 'node:fs/promises'
import type { Event as WatcherEvent } from '@parcel/watcher'
import type { FsChangeEvent, FsChangedPayload } from '../../shared/types'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import { isWslPath } from '../wsl'
import { createWslWatcher } from './filesystem-watcher-wsl'
import type { WatchedRoot } from './filesystem-watcher-wsl'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { MAX_BATCHED_WATCHER_EVENTS, queueWatcherEvents } from './filesystem-watcher-event-batch'
import { disposeWatcherProcess, subscribeViaWatcherProcess } from './parcel-watcher-process'
import { isWatcherProcessFailure } from './parcel-watcher-process-failure'
import {
  onWatcherChildCapacityAvailable,
  WatcherChildCapacityError
} from './parcel-watcher-child-registry'
import { beginWatcherInstall, isWatcherRemovalInProgressError } from './watcher-removal-gate'
// Why: suppress high-churn dirs at the watcher level (separate from the File Explorer display filter, which only hides rows).
import { WATCHER_IGNORE_DIRS, buildParcelWatcherIgnoreOptions } from './filesystem-watcher-ignore'

// ── Debounce helpers ─────────────────────────────────────────────────

const DEBOUNCE_TRAILING_MS = 150
const DEBOUNCE_MAX_WAIT_MS = 500

// ── Per-root watcher state ───────────────────────────────────────────
// WatchedRoot/WatcherSubscription live in filesystem-watcher-wsl.ts so native and WSL watchers share one shape.

// ── Module state ─────────────────────────────────────────────────────

const watchedRoots = new Map<string, WatchedRoot>()

// Why: cache roots that failed watcher creation (e.g. WSL UNC paths) so we don't retry every worktree switch and spam the console with errors.
const UNWATCHABLE_ROOT_CACHE_MAX = 256
const unwatchableRoots = new Set<string>()

function rememberUnwatchableRoot(rootKey: string): void {
  // Why: deleted worktrees churn through unique paths; cap the set so retry suppression stays useful without retaining every failed path.
  unwatchableRoots.delete(rootKey)
  unwatchableRoots.add(rootKey)
  while (unwatchableRoots.size > UNWATCHABLE_ROOT_CACHE_MAX) {
    const oldest = unwatchableRoots.keys().next().value
    if (oldest === undefined) {
      break
    }
    unwatchableRoots.delete(oldest)
  }
}

// Why: key cleanup by sender WebContents (not per root) to avoid MaxListeners warnings when a workspace has many worktrees open.
const senderCleanupRegistered = new Set<number>()

// Why: recreating @parcel/watcher on Windows is expensive (ReadDirectoryChangesW + AV, 500ms+); a 30s grace lets rapid switches reuse the watcher.
const WATCHER_TEARDOWN_GRACE_MS = 30_000
const pendingTeardowns = new Map<string, ReturnType<typeof setTimeout>>()
// Why: @parcel/watcher unsubscribe does native async work that sender-destroy can start before shutdown, so will-quit must still await it.
const pendingLocalUnsubscribes = new Set<Promise<void>>()
const pendingLocalUnsubscribesByRoot = new Map<string, Set<Promise<void>>>()
const suspendedLocalWatcherListeners = new Map<
  string,
  { worktreePath: string; listeners: Map<number, WebContents> }
>()
// Why: an install cancelled by shutdown can't be revived by a waiter that resumes after a later call reopens the subsystem.
let localWatchersClosed = false
let localWatcherLifecycleGeneration = 0
const failedLocalUnsubscribes = new Map<string, unknown>()
type LocalWatcherInstallToken = {
  cancelled: boolean
  listeners: Map<number, WebContents>
  abortController: AbortController
}
type LocalWatcherInstallResult = 'installed' | 'unavailable' | 'capacity' | 'cancelled'
type LocalWatcherCapacityRetry = {
  listeners: Map<number, WebContents>
  cancelWait: () => void
}
// Why: watcher creation is async; concurrent watch requests for the same root must share one install or later resolves orphan listeners.
const inFlightLocalInstalls = new Map<string, LocalWatcherInstallToken>()
const pendingLocalInstallPromises = new Map<string, Promise<LocalWatcherInstallResult>>()
const pendingLocalCapacityRetries = new Map<string, LocalWatcherCapacityRetry>()

function addInFlightLocalInstallListener(
  token: LocalWatcherInstallToken,
  sender: WebContents
): void {
  if (sender.isDestroyed() || token.abortController.signal.aborted) {
    return
  }
  token.listeners.set(sender.id, sender)
  token.cancelled = false
  registerSenderCleanup(sender)
}

function cleanupInFlightLocalInstallsForSender(senderId: number): void {
  for (const token of inFlightLocalInstalls.values()) {
    token.listeners.delete(senderId)
    if (token.listeners.size === 0) {
      token.cancelled = true
      // Why: abort so a pending native/forked subscription stops early (matches closeLocalWatcherForWorktreePath / closeAllWatchers).
      token.abortController.abort()
    }
  }
  for (const [rootKey, retry] of pendingLocalCapacityRetries) {
    retry.listeners.delete(senderId)
    if (retry.listeners.size === 0) {
      retry.cancelWait()
      pendingLocalCapacityRetries.delete(rootKey)
    }
  }
}

function takeLocalCapacityRetryListeners(rootKey: string): WebContents[] {
  const retry = pendingLocalCapacityRetries.get(rootKey)
  if (!retry) {
    return []
  }
  retry.cancelWait()
  pendingLocalCapacityRetries.delete(rootKey)
  return [...retry.listeners.values()].filter((listener) => !listener.isDestroyed())
}

function clearLocalCapacityRetry(rootKey: string): void {
  const retry = pendingLocalCapacityRetries.get(rootKey)
  retry?.cancelWait()
  pendingLocalCapacityRetries.delete(rootKey)
}

function scheduleLocalCapacityRetry(
  rootKey: string,
  worktreePath: string,
  listeners: Map<number, WebContents>
): void {
  const existing = pendingLocalCapacityRetries.get(rootKey)
  if (existing) {
    for (const listener of listeners.values()) {
      if (!listener.isDestroyed()) {
        existing.listeners.set(listener.id, listener)
      }
    }
    return
  }

  let retry!: LocalWatcherCapacityRetry
  const cancelWait = onWatcherChildCapacityAvailable(async () => {
    if (pendingLocalCapacityRetries.get(rootKey) !== retry) {
      return
    }
    pendingLocalCapacityRetries.delete(rootKey)
    await Promise.all(
      [...retry.listeners.values()].map(async (listener) => {
        if (listener.isDestroyed()) {
          return
        }
        await subscribe(worktreePath, listener).catch((error: unknown) => {
          if (!isWatcherRemovalInProgressError(error)) {
            console.error(`[filesystem-watcher] capacity retry failed for ${rootKey}:`, error)
          }
        })
      })
    )
  })
  retry = { listeners: new Map(), cancelWait }
  pendingLocalCapacityRetries.set(rootKey, retry)
  for (const listener of listeners.values()) {
    if (!listener.isDestroyed()) {
      retry.listeners.set(listener.id, listener)
      registerSenderCleanup(listener)
    }
  }
  if (retry.listeners.size === 0) {
    clearLocalCapacityRetry(rootKey)
  }
}

// ── Path normalization ───────────────────────────────────────────────

function normalizeRootPath(rootPath: string): string {
  let resolved = isWindowsAbsolutePathLike(rootPath)
    ? path.win32.resolve(rootPath)
    : path.resolve(rootPath)
  // Why: Windows watcher events may use lowercase drive letters vs stored uppercase; normalize so renderer casing stays consistent (§4.4).
  if (/^[a-zA-Z]:/.test(resolved)) {
    resolved = resolved.charAt(0).toUpperCase() + resolved.slice(1)
  }
  return resolved
}

function localWatcherRoot(rootPath: string): { key: string; path: string } {
  const normalizedPath = normalizeRootPath(rootPath)
  return {
    // Why: Windows drive/UNC paths are case-insensitive; cleanup must match the owner even when Git returns a different spelling.
    key: normalizeRuntimePathForComparison(normalizedPath),
    path: normalizedPath
  }
}

function normalizeEventPath(eventPath: string): string {
  let resolved = path.resolve(eventPath)
  if (/^[a-zA-Z]:/.test(resolved)) {
    resolved = resolved.charAt(0).toUpperCase() + resolved.slice(1)
  }
  return resolved
}

// ── Event coalescing ─────────────────────────────────────────────────
// Why: keep the last event per path in a flush window; delete→create emits both (delete cleans the subtree, create refreshes the parent), create→delete is dropped (§4.4).

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

function emitOverflowPayload(rootKey: string, root: WatchedRoot): void {
  const rootPath = root.rootPath ?? rootKey
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

async function flushBatch(rootKey: string, root: WatchedRoot): Promise<void> {
  const overflowed = root.batch.overflowed
  const rawEvents = root.batch.events.splice(0)
  root.batch.overflowed = false
  root.batch.timer = null
  root.batch.firstEventAt = 0

  if ((rawEvents.length === 0 && !overflowed) || root.listeners.size === 0) {
    return
  }

  if (overflowed || rawEvents.length > MAX_BATCHED_WATCHER_EVENTS) {
    // Why: deletion storms can be too large to coalesce/stat per path; one overflow asks the renderer for the same conservative refresh.
    emitOverflowPayload(rootKey, root)
    return
  }

  const coalesced = coalesceEvents(rawEvents)

  const events: FsChangeEvent[] = await Promise.all(
    coalesced.map(async (evt) => {
      // Why: a deleted path can't be stat'd; leave isDirectory undefined and let the renderer infer from dirCache.
      const isDirectory = evt.type === 'delete' ? undefined : await tryStatIsDirectory(evt.path)

      return {
        kind: evt.type,
        absolutePath: evt.path,
        isDirectory
      }
    })
  )

  const payload: FsChangedPayload = {
    worktreePath: root.rootPath ?? rootKey,
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

async function createWatcher(
  rootKey: string,
  rootPath: string,
  signal?: AbortSignal
): Promise<WatchedRoot> {
  const root: WatchedRoot = {
    subscription: null!,
    listeners: new Map(),
    batch: { events: [], overflowed: false, timer: null, firstEventAt: 0 },
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
      scheduleBatchFlush(rootKey, root)
    }

    // Why: fork the watcher process (issue #7547 — watcher.node teardown races crash the host); onInterruption marks overflow to refresh past the gap.
    root.subscription = await subscribeViaWatcherProcess(
      rootPath,
      (err, events) => {
        if (err) {
          // Why: treat watcher errors as overflow so the renderer conservatively refreshes rather than trusting possibly-invalid caches (§7.2, §7.3).
          console.error(`[filesystem-watcher] error for ${rootKey}:`, err)
          emitOverflowPayload(rootKey, root)
          // Why: after an error the native subscription may be invalid (deleted root); tear down the dead watcher so it doesn't dangle (§7.3).
          if (root.batch.timer) {
            clearTimeout(root.batch.timer)
          }
          // Why: error callback can fire before subscribe() assigns root.subscription; guard against null so cleanup doesn't crash.
          if (root.subscription) {
            retainLocalWatcherPhysicalFailure(rootKey, err)
            void trackLocalUnsubscribe(rootKey, root)
          }
          errorCleanedUp = true
          watchedRoots.delete(rootKey)
          return
        }

        queueWatcherEvents(root.batch, events)
        scheduleBatchFlush(rootKey, root)
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
      void trackLocalUnsubscribe(rootKey, root)
      throw new Error(`Watcher for ${rootKey} errored during subscribe`)
    }
  } catch (err) {
    // Why: watcher backend can throw synchronously on a deleted root/permission error; log rather than crash the main process (§7.3).
    console.error(`[filesystem-watcher] failed to subscribe ${rootKey}:`, err)
    throw err
  }

  return root
}

// ── Subscribe / Unsubscribe ──────────────────────────────────────────

function cleanupLocalWatchersForSender(senderId: number): void {
  for (const [rootKey, suspended] of suspendedLocalWatcherListeners) {
    suspended.listeners.delete(senderId)
    if (suspended.listeners.size === 0) {
      suspendedLocalWatcherListeners.delete(rootKey)
    }
  }
  cleanupInFlightLocalInstallsForSender(senderId)
  for (const [key, watchedRoot] of watchedRoots) {
    if (watchedRoot.listeners.has(senderId)) {
      watchedRoot.listeners.delete(senderId)
      if (watchedRoot.listeners.size === 0) {
        // Cancel any pending grace-period teardown for this root.
        const pending = pendingTeardowns.get(key)
        if (pending) {
          clearTimeout(pending)
          pendingTeardowns.delete(key)
        }
        if (watchedRoot.batch.timer) {
          clearTimeout(watchedRoot.batch.timer)
        }
        trackLocalUnsubscribe(key, watchedRoot)
        watchedRoots.delete(key)
      }
    }
  }
}

function trackLocalUnsubscribe(rootKey: string, root: WatchedRoot): Promise<void> {
  const rootUnsubscribes = pendingLocalUnsubscribesByRoot.get(rootKey) ?? new Set<Promise<void>>()
  pendingLocalUnsubscribesByRoot.set(rootKey, rootUnsubscribes)
  const unsubscribePromise = Promise.resolve()
    .then(() => root.subscription.unsubscribe())
    .finally(() => {
      pendingLocalUnsubscribes.delete(unsubscribePromise)
      rootUnsubscribes.delete(unsubscribePromise)
      if (rootUnsubscribes.size === 0) {
        pendingLocalUnsubscribesByRoot.delete(rootKey)
      }
    })
  pendingLocalUnsubscribes.add(unsubscribePromise)
  rootUnsubscribes.add(unsubscribePromise)
  // Why: swallow here to avoid unhandled rejections, but keep the original promise rejected so later destructive cleanup can fail closed.
  void unsubscribePromise.catch((error: unknown) => {
    retainLocalWatcherPhysicalFailure(rootKey, error)
    console.error(`[filesystem-watcher] unsubscribe error for ${rootKey}:`, error)
  })
  return unsubscribePromise
}

function retainLocalWatcherPhysicalFailure(rootKey: string, error: unknown): void {
  if (!isWatcherProcessFailure(error) || !error.physicalExit) {
    return
  }
  failedLocalUnsubscribes.set(rootKey, error)
  void error.physicalExit.then(() => {
    if (failedLocalUnsubscribes.get(rootKey) === error) {
      failedLocalUnsubscribes.delete(rootKey)
    }
  })
}

function registerSenderCleanup(sender: WebContents): void {
  if (senderCleanupRegistered.has(sender.id)) {
    return
  }
  senderCleanupRegistered.add(sender.id)
  sender.once('destroyed', () => {
    senderCleanupRegistered.delete(sender.id)
    cleanupLocalWatchersForSender(sender.id)
    cleanupRemoteWatchersForSender(sender.id)
  })
}

function addLocalWatchListener(rootKey: string, sender: WebContents): void {
  const root = watchedRoots.get(rootKey)
  if (!root || sender.isDestroyed()) {
    return
  }
  root.listeners.set(sender.id, sender)
  registerSenderCleanup(sender)
}

async function subscribe(
  worktreePath: string,
  sender: WebContents,
  generation = localWatcherLifecycleGeneration
): Promise<void> {
  if (localWatchersClosed || generation !== localWatcherLifecycleGeneration) {
    return
  }
  const finishInstall = beginWatcherInstall(worktreePath)
  try {
    await subscribeWhileRemovalAllowed(worktreePath, sender, generation)
  } finally {
    finishInstall()
  }
}

async function subscribeWhileRemovalAllowed(
  worktreePath: string,
  sender: WebContents,
  generation: number
): Promise<void> {
  if (localWatchersClosed || generation !== localWatcherLifecycleGeneration) {
    return
  }
  const { key: rootKey, path: rootPath } = localWatcherRoot(worktreePath)
  if (sender.isDestroyed()) {
    return
  }

  // Don't retry roots that already failed — avoids repeated error spam.
  if (unwatchableRoots.has(rootKey)) {
    rememberUnwatchableRoot(rootKey)
    return
  }

  let root = watchedRoots.get(rootKey)

  // Cancel any pending grace-period teardown — a new listener arrived.
  const pendingTeardown = pendingTeardowns.get(rootKey)
  if (pendingTeardown) {
    clearTimeout(pendingTeardown)
    pendingTeardowns.delete(rootKey)
  }
  const capacityRetryListeners = takeLocalCapacityRetryListeners(rootKey)

  if (root) {
    for (const listener of capacityRetryListeners) {
      addLocalWatchListener(rootKey, listener)
    }
    addLocalWatchListener(rootKey, sender)
    return
  }

  const pendingInstall = pendingLocalInstallPromises.get(rootKey)
  if (pendingInstall) {
    const inFlight = inFlightLocalInstalls.get(rootKey)
    const canJoinInstall = inFlight && !inFlight.abortController.signal.aborted
    if (canJoinInstall) {
      // Why: an unwatch may cancel an install while another renderer awaits the same root; a new live listener keeps it alive.
      addInFlightLocalInstallListener(inFlight, sender)
      for (const listener of capacityRetryListeners) {
        addInFlightLocalInstallListener(inFlight, listener)
      }
    }
    const result = await pendingInstall
    if (
      result === 'cancelled' &&
      !canJoinInstall &&
      !localWatchersClosed &&
      generation === localWatcherLifecycleGeneration
    ) {
      // Why: AbortSignal can't be revived; listeners arriving after cancellation wait out that generation, then own a fresh install.
      if (pendingLocalInstallPromises.get(rootKey) === pendingInstall) {
        pendingLocalInstallPromises.delete(rootKey)
      }
      const retryListeners = new Map(
        capacityRetryListeners.map((listener) => [listener.id, listener])
      )
      retryListeners.set(sender.id, sender)
      for (const listener of retryListeners.values()) {
        if (!listener.isDestroyed()) {
          await subscribeWhileRemovalAllowed(worktreePath, listener, generation)
        }
      }
      return
    }
    if (!inFlight) {
      if (result === 'installed') {
        for (const listener of capacityRetryListeners) {
          addLocalWatchListener(rootKey, listener)
        }
      } else if (result === 'capacity') {
        const retryListeners = new Map(
          capacityRetryListeners.map((listener) => [listener.id, listener])
        )
        retryListeners.set(sender.id, sender)
        scheduleLocalCapacityRetry(rootKey, worktreePath, retryListeners)
      }
    }
    if (
      result === 'installed' &&
      watchedRoots.has(rootKey) &&
      !sender.isDestroyed() &&
      (!inFlight || inFlight.listeners.has(sender.id))
    ) {
      addLocalWatchListener(rootKey, sender)
    }
    return
  }

  const cancelToken: LocalWatcherInstallToken = {
    cancelled: false,
    listeners: new Map(),
    abortController: new AbortController()
  }
  inFlightLocalInstalls.set(rootKey, cancelToken)
  for (const listener of capacityRetryListeners) {
    addInFlightLocalInstallListener(cancelToken, listener)
  }
  addInFlightLocalInstallListener(cancelToken, sender)
  const installPromise = doInstallLocalWatcher(rootKey, rootPath, worktreePath, cancelToken)
  pendingLocalInstallPromises.set(rootKey, installPromise)
  try {
    await installPromise
  } finally {
    if (pendingLocalInstallPromises.get(rootKey) === installPromise) {
      pendingLocalInstallPromises.delete(rootKey)
    }
  }
}

async function doInstallLocalWatcher(
  rootKey: string,
  rootPath: string,
  worktreePath: string,
  cancelToken: LocalWatcherInstallToken
): Promise<LocalWatcherInstallResult> {
  let root: WatchedRoot
  try {
    const s = await stat(rootPath)
    if (!s.isDirectory()) {
      console.warn(`[filesystem-watcher] not a directory: ${rootKey}`)
      rememberUnwatchableRoot(rootKey)
      return 'unavailable'
    }
  } catch {
    console.warn(`[filesystem-watcher] cannot stat root: ${rootKey}`)
    rememberUnwatchableRoot(rootKey)
    return 'unavailable'
  }

  try {
    // Why: WSL paths use one snapshot subprocess inside the distro so `wsl --shutdown` can kill it; native Windows uses @parcel/watcher.
    root = isWslPath(worktreePath)
      ? await createWslWatcher(
          rootKey,
          worktreePath,
          {
            ignoreDirs: WATCHER_IGNORE_DIRS,
            scheduleBatchFlush,
            watchedRoots
          },
          cancelToken.abortController.signal
        )
      : await createWatcher(rootKey, rootPath, cancelToken.abortController.signal)
  } catch (error) {
    // Why: setup can fail after its child misses the exit deadline; retain that owner even when the renderer-facing error is swallowed.
    retainLocalWatcherPhysicalFailure(rootKey, error)
    if (cancelToken.cancelled) {
      if (isWatcherProcessFailure(error) && error.code === 'process_unavailable') {
        throw error
      }
      return 'cancelled'
    }
    // Why: capacity is transient — allow retry once another child exits instead of caching this root as permanently failed.
    if (error instanceof WatcherChildCapacityError) {
      scheduleLocalCapacityRetry(rootKey, worktreePath, cancelToken.listeners)
      return 'capacity'
    }
    rememberUnwatchableRoot(rootKey)
    return 'unavailable'
  } finally {
    if (inFlightLocalInstalls.get(rootKey) === cancelToken) {
      inFlightLocalInstalls.delete(rootKey)
    }
  }

  const liveListeners = new Map(
    Array.from(cancelToken.listeners.entries()).filter(([, listener]) => !listener.isDestroyed())
  )
  if (cancelToken.cancelled || liveListeners.size === 0) {
    if (root.batch.timer) {
      clearTimeout(root.batch.timer)
    }
    void trackLocalUnsubscribe(rootKey, root)
    return 'cancelled'
  }

  root.listeners = liveListeners
  watchedRoots.set(rootKey, root)
  for (const listener of liveListeners.values()) {
    registerSenderCleanup(listener)
  }
  return 'installed'
}

function unsubscribe(worktreePath: string, senderId: number): void {
  const { key: rootKey } = localWatcherRoot(worktreePath)
  const suspended = suspendedLocalWatcherListeners.get(rootKey)
  suspended?.listeners.delete(senderId)
  if (suspended?.listeners.size === 0) {
    suspendedLocalWatcherListeners.delete(rootKey)
  }
  const capacityRetry = pendingLocalCapacityRetries.get(rootKey)
  if (capacityRetry) {
    capacityRetry.listeners.delete(senderId)
    if (capacityRetry.listeners.size === 0) {
      clearLocalCapacityRetry(rootKey)
    }
  }
  const inFlight = inFlightLocalInstalls.get(rootKey)
  if (inFlight) {
    inFlight.listeners.delete(senderId)
    inFlight.cancelled = inFlight.listeners.size === 0
    // Why: last normal disconnect must abort the pending native/forked install (same early-cancel as closeLocalWatcherForWorktreePath).
    if (inFlight.cancelled) {
      inFlight.abortController.abort()
    }
  }

  const root = watchedRoots.get(rootKey)
  if (!root) {
    return
  }

  root.listeners.delete(senderId)

  // Defer teardown when the last subscriber leaves so rapid worktree switches reuse the native watcher.
  if (root.listeners.size === 0) {
    if (root.batch.timer) {
      clearTimeout(root.batch.timer)
    }

    // Why: duplicate unwatch calls for a root would leak overwritten grace timers; keep just one.
    if (pendingTeardowns.has(rootKey)) {
      return
    }

    const teardownTimer = setTimeout(() => {
      pendingTeardowns.delete(rootKey)
      // Re-check: a new listener may have arrived during the grace period.
      const currentRoot = watchedRoots.get(rootKey)
      if (!currentRoot || currentRoot.listeners.size > 0) {
        return
      }
      void trackLocalUnsubscribe(rootKey, currentRoot)
      watchedRoots.delete(rootKey)
    }, WATCHER_TEARDOWN_GRACE_MS)

    pendingTeardowns.set(rootKey, teardownTimer)
  }
}

export async function closeLocalWatcherForWorktreePath(worktreePath: string): Promise<void> {
  const { key: rootKey } = localWatcherRoot(worktreePath)
  const suspended = suspendedLocalWatcherListeners.get(rootKey) ?? {
    worktreePath,
    listeners: new Map<number, WebContents>()
  }
  for (const source of [
    pendingLocalCapacityRetries.get(rootKey)?.listeners,
    inFlightLocalInstalls.get(rootKey)?.listeners,
    watchedRoots.get(rootKey)?.listeners
  ]) {
    for (const [senderId, sender] of source ?? []) {
      if (!sender.isDestroyed()) {
        suspended.listeners.set(senderId, sender)
      }
    }
  }
  if (suspended.listeners.size > 0) {
    suspendedLocalWatcherListeners.set(rootKey, suspended)
  }
  clearLocalCapacityRetry(rootKey)
  const pendingTeardown = pendingTeardowns.get(rootKey)
  if (pendingTeardown) {
    clearTimeout(pendingTeardown)
    pendingTeardowns.delete(rootKey)
  }

  const inFlight = inFlightLocalInstalls.get(rootKey)
  if (inFlight) {
    // Why: Windows locks watched directories; deletion must cancel an in-flight subscription before Git removes the tree.
    inFlight.listeners.clear()
    inFlight.cancelled = true
    inFlight.abortController.abort()
  }
  await pendingLocalInstallPromises.get(rootKey)
  const pendingUnsubscribes = pendingLocalUnsubscribesByRoot.get(rootKey)
  if (pendingUnsubscribes) {
    await Promise.all(Array.from(pendingUnsubscribes))
  }
  if (failedLocalUnsubscribes.has(rootKey)) {
    throw failedLocalUnsubscribes.get(rootKey)
  }

  const root = watchedRoots.get(rootKey)
  if (!root) {
    return
  }
  if (root.batch.timer) {
    clearTimeout(root.batch.timer)
  }
  watchedRoots.delete(rootKey)
  await trackLocalUnsubscribe(rootKey, root)
}

export async function restoreLocalWatcherAfterFailedRemoval(worktreePath: string): Promise<void> {
  const { key: rootKey } = localWatcherRoot(worktreePath)
  const suspended = suspendedLocalWatcherListeners.get(rootKey)
  if (!suspended) {
    return
  }
  suspendedLocalWatcherListeners.delete(rootKey)
  const failures: unknown[] = []
  const failedListeners = new Map<number, WebContents>()
  for (const sender of suspended.listeners.values()) {
    if (sender.isDestroyed()) {
      continue
    }
    try {
      await subscribe(suspended.worktreePath, sender)
      sender.send('fs:changed', {
        worktreePath: suspended.worktreePath,
        events: [{ kind: 'overflow', absolutePath: suspended.worktreePath }]
      } satisfies FsChangedPayload)
    } catch (error) {
      failures.push(error)
      failedListeners.set(sender.id, sender)
    }
  }
  if (failures.length > 0) {
    suspendedLocalWatcherListeners.set(rootKey, {
      worktreePath: suspended.worktreePath,
      listeners: failedListeners
    })
    throw failures[0]
  }
}

export function forgetLocalWatcherRemovalSnapshot(worktreePath: string): void {
  suspendedLocalWatcherListeners.delete(localWatcherRoot(worktreePath).key)
}

// Remote watcher state
type RemoteWatcherState = {
  unwatch: () => void
  listeners: Map<number, WebContents>
  installToken: RemoteWatcherInstallToken
}

type RemoteWatcherInstallToken = {
  cancelled: boolean
  listeners: Map<number, WebContents>
  abortController: AbortController
  abortScheduled: boolean
  terminalError?: Error
}

// Key: `${connectionId}:${worktreePath}`, Value: shared remote watch state.
const remoteWatchers = new Map<string, RemoteWatcherState>()
const suspendedRemoteWatcherListeners = new Map<
  string,
  { connectionId: string; worktreePath: string; listeners: Map<number, WebContents> }
>()
const loggedUnavailableRemoteWatchers = new Set<string>()
const pendingRemoteWatcherRetries = new Map<string, ReturnType<typeof setTimeout>>()
const pendingRemoteWatcherRetryListeners = new Map<
  string,
  { listeners: Map<number, WebContents>; startedAt: number }
>()
// Why: last-listener cleanup aborts relay setup; late success is unwatched rather than installed after the renderer stopped watching.
const inFlightRemoteInstalls = new Map<string, RemoteWatcherInstallToken>()
// Why: dedupe concurrent installRemoteWatcher calls per key so overlapping watches share one watcher instead of clobbering per-key state.
const pendingRemoteInstallPromises = new Map<string, Promise<RemoteWatcherInstallResult>>()
// Why: block installs beginning after closeAllWatchers (joiner recursion / retry tick bypass the abort loop); a new fs:watchWorktree clears it.
let remoteWatchersClosed = false
// Why: closeAllWatchers bumps this so a joiner that awaited across shutdown+reopen is refused (the latch alone can't tell it from a fresh call).
let remoteWatcherLifecycleGeneration = 0
const REMOTE_WATCH_RETRY_MS = 1_000
const REMOTE_WATCH_RETRY_TIMEOUT_MS = 60_000

export async function closeRemoteWatcherForWorktreePath(
  connectionId: string,
  worktreePath: string
): Promise<void> {
  const key = remoteWatcherKey(connectionId, worktreePath)
  const suspended = suspendedRemoteWatcherListeners.get(key) ?? {
    connectionId,
    worktreePath,
    listeners: new Map<number, WebContents>()
  }
  for (const source of [
    pendingRemoteWatcherRetryListeners.get(key)?.listeners,
    inFlightRemoteInstalls.get(key)?.listeners,
    remoteWatchers.get(key)?.listeners
  ]) {
    for (const [senderId, sender] of source ?? []) {
      if (!sender.isDestroyed()) {
        suspended.listeners.set(senderId, sender)
      }
    }
  }
  if (suspended.listeners.size > 0) {
    suspendedRemoteWatcherListeners.set(key, suspended)
  }
  const retryTimer = pendingRemoteWatcherRetries.get(key)
  if (retryTimer) {
    clearTimeout(retryTimer)
    pendingRemoteWatcherRetries.delete(key)
    pendingRemoteWatcherRetryListeners.delete(key)
  }
  const inFlight = inFlightRemoteInstalls.get(key)
  if (inFlight) {
    inFlight.listeners.clear()
    inFlight.cancelled = true
  }
  const state = remoteWatchers.get(key)
  const provider = getSshFilesystemProvider(connectionId)
  await (provider?.closeWatch
    ? provider.closeWatch(worktreePath)
    : Promise.resolve(state?.unwatch()))
  remoteWatchers.delete(key)
  loggedUnavailableRemoteWatchers.delete(key)
}

export async function restoreRemoteWatcherAfterFailedRemoval(
  connectionId: string,
  worktreePath: string
): Promise<void> {
  const key = remoteWatcherKey(connectionId, worktreePath)
  const suspended = suspendedRemoteWatcherListeners.get(key)
  if (!suspended) {
    return
  }
  suspendedRemoteWatcherListeners.delete(key)
  for (const sender of suspended.listeners.values()) {
    if (sender.isDestroyed()) {
      continue
    }
    const result = await installRemoteWatcher(sender, connectionId, worktreePath)
    if (result === 'unavailable') {
      scheduleRemoteWatcherRetry(sender, connectionId, worktreePath)
    }
    sender.send('fs:changed', {
      worktreePath,
      events: [{ kind: 'overflow', absolutePath: worktreePath }]
    } satisfies FsChangedPayload)
  }
}

export function forgetRemoteWatcherRemovalSnapshot(
  connectionId: string,
  worktreePath: string
): void {
  suspendedRemoteWatcherListeners.delete(remoteWatcherKey(connectionId, worktreePath))
}

function addInFlightRemoteInstallListener(
  token: RemoteWatcherInstallToken,
  sender: WebContents
): void {
  if (sender.isDestroyed() || token.abortController.signal.aborted) {
    return
  }
  token.listeners.set(sender.id, sender)
  token.cancelled = false
  registerSenderCleanup(sender)
}

function cancelInFlightRemoteInstallIfUnowned(token: RemoteWatcherInstallToken): void {
  token.cancelled = token.listeners.size === 0
  if (!token.cancelled || token.abortScheduled || token.abortController.signal.aborted) {
    return
  }
  token.abortScheduled = true
  // Why: a replacement sender can synchronously revive the shared install during a renderer handoff; otherwise stop the relay crawl next microtask.
  queueMicrotask(() => {
    token.abortScheduled = false
    if (token.cancelled && token.listeners.size === 0) {
      token.abortController.abort()
    }
  })
}

function cleanupInFlightRemoteInstallsForSender(senderId: number): void {
  for (const token of inFlightRemoteInstalls.values()) {
    token.listeners.delete(senderId)
    cancelInFlightRemoteInstallIfUnowned(token)
  }
  for (const [key, retry] of pendingRemoteWatcherRetryListeners) {
    retry.listeners.delete(senderId)
    if (retry.listeners.size === 0) {
      const timer = pendingRemoteWatcherRetries.get(key)
      if (timer) {
        clearTimeout(timer)
        pendingRemoteWatcherRetries.delete(key)
      }
      pendingRemoteWatcherRetryListeners.delete(key)
    }
  }
}

function addRemoteWatchListener(key: string, sender: WebContents): void {
  const state = remoteWatchers.get(key)
  if (!state) {
    return
  }
  state.listeners.set(sender.id, sender)
  registerSenderCleanup(sender)
}

function releaseRemoteWatchListener(key: string, senderId: number): void {
  const state = remoteWatchers.get(key)
  if (!state) {
    return
  }
  state.listeners.delete(senderId)
  if (state.listeners.size > 0) {
    return
  }
  state.unwatch()
  remoteWatchers.delete(key)
}

function cleanupRemoteWatchersForSender(senderId: number): void {
  for (const [key, suspended] of suspendedRemoteWatcherListeners) {
    suspended.listeners.delete(senderId)
    if (suspended.listeners.size === 0) {
      suspendedRemoteWatcherListeners.delete(key)
    }
  }
  cleanupInFlightRemoteInstallsForSender(senderId)
  for (const key of Array.from(remoteWatchers.keys())) {
    releaseRemoteWatchListener(key, senderId)
  }
}

type RemoteWatcherInstallResult = 'installed' | 'unavailable' | 'cancelled'

async function installRemoteWatcher(
  sender: WebContents,
  connectionId: string,
  worktreePath: string,
  generation = remoteWatcherLifecycleGeneration
): Promise<RemoteWatcherInstallResult> {
  // Why: refuse installs racing in after teardown (or a waiter from an earlier lifecycle) so provider.watch() isn't called post-shutdown.
  if (remoteWatchersClosed || generation !== remoteWatcherLifecycleGeneration) {
    return 'cancelled'
  }
  const finishInstall = beginWatcherInstall(worktreePath, connectionId)
  try {
    return await installRemoteWatcherWhileRemovalAllowed(
      sender,
      connectionId,
      worktreePath,
      generation
    )
  } finally {
    finishInstall()
  }
}

async function installRemoteWatcherWhileRemovalAllowed(
  sender: WebContents,
  connectionId: string,
  worktreePath: string,
  generation: number
): Promise<RemoteWatcherInstallResult> {
  const provider = getSshFilesystemProvider(connectionId)
  if (!provider || sender.isDestroyed()) {
    return 'unavailable'
  }

  const key = remoteWatcherKey(connectionId, worktreePath)
  const existing = remoteWatchers.get(key)
  if (existing) {
    addRemoteWatchListener(key, sender)
    return 'installed'
  }
  // Why: concurrent same-key watches must share the first provider.watch(); separate watchers would clobber per-key state and drop the unwatch handle.
  const pendingInstall = pendingRemoteInstallPromises.get(key)
  if (pendingInstall) {
    const inFlight = inFlightRemoteInstalls.get(key)
    const canJoinInstall = inFlight && !inFlight.abortController.signal.aborted
    if (canJoinInstall) {
      // Why: a new watcher joining before provider.watch() resolves should revive the install instead of inheriting the stale cancellation.
      addInFlightRemoteInstallListener(inFlight, sender)
    }
    const result = await pendingInstall
    if (
      result === 'installed' &&
      remoteWatchers.has(key) &&
      !sender.isDestroyed() &&
      (!inFlight || inFlight.listeners.has(sender.id))
    ) {
      addRemoteWatchListener(key, sender)
    }
    if (
      result === 'cancelled' &&
      !canJoinInstall &&
      !sender.isDestroyed() &&
      generation === remoteWatcherLifecycleGeneration
    ) {
      // Why: AbortSignal can't be revived; a listener arriving after cancellation waits out that generation, then owns a fresh install.
      if (pendingRemoteInstallPromises.get(key) === pendingInstall) {
        pendingRemoteInstallPromises.delete(key)
      }
      return installRemoteWatcher(sender, connectionId, worktreePath, generation)
    }
    return result
  }
  const cancelToken: RemoteWatcherInstallToken = {
    cancelled: false,
    listeners: new Map(),
    abortController: new AbortController(),
    abortScheduled: false
  }
  inFlightRemoteInstalls.set(key, cancelToken)
  addInFlightRemoteInstallListener(cancelToken, sender)
  const installPromise = doInstallRemoteWatcher(
    provider,
    key,
    connectionId,
    worktreePath,
    cancelToken
  )
  pendingRemoteInstallPromises.set(key, installPromise)
  try {
    return await installPromise
  } finally {
    if (pendingRemoteInstallPromises.get(key) === installPromise) {
      pendingRemoteInstallPromises.delete(key)
    }
  }
}

async function doInstallRemoteWatcher(
  provider: NonNullable<ReturnType<typeof getSshFilesystemProvider>>,
  key: string,
  connectionId: string,
  worktreePath: string,
  cancelToken: RemoteWatcherInstallToken
): Promise<RemoteWatcherInstallResult> {
  let unwatch: () => void
  try {
    unwatch = await provider.watch(
      worktreePath,
      (events) => {
        const state = remoteWatchers.get(key)
        if (!state) {
          return
        }
        for (const listener of state.listeners.values()) {
          if (listener.isDestroyed()) {
            continue
          }
          listener.send('fs:changed', {
            worktreePath,
            events
          } satisfies FsChangedPayload)
        }
      },
      {
        signal: cancelToken.abortController.signal,
        onTerminalError: (error) =>
          handleRemoteWatcherTerminalError(key, connectionId, worktreePath, cancelToken, error)
      }
    )
  } catch (err) {
    if (cancelToken.cancelled || cancelToken.abortController.signal.aborted) {
      return 'cancelled'
    }
    console.warn(`[filesystem-watcher] SSH watcher unavailable for ${key}:`, err)
    return 'unavailable'
  } finally {
    if (inFlightRemoteInstalls.get(key) === cancelToken) {
      inFlightRemoteInstalls.delete(key)
    }
  }
  const liveListeners = new Map(
    Array.from(cancelToken.listeners.entries()).filter(([, listener]) => !listener.isDestroyed())
  )
  if (cancelToken.cancelled || liveListeners.size === 0) {
    try {
      unwatch()
    } catch (err) {
      console.error(`[filesystem-watcher] remote unwatch (post-cancel) error for ${key}:`, err)
    }
    return 'cancelled'
  }
  if (cancelToken.terminalError) {
    return 'unavailable'
  }
  remoteWatchers.set(key, { unwatch, listeners: liveListeners, installToken: cancelToken })
  for (const listener of liveListeners.values()) {
    registerSenderCleanup(listener)
  }
  loggedUnavailableRemoteWatchers.delete(key)
  return 'installed'
}

function handleRemoteWatcherTerminalError(
  key: string,
  connectionId: string,
  worktreePath: string,
  installToken: RemoteWatcherInstallToken,
  error: Error
): void {
  installToken.terminalError = error
  const state = remoteWatchers.get(key)
  if (!state || state.installToken !== installToken) {
    return
  }
  remoteWatchers.delete(key)
  console.warn(`[filesystem-watcher] SSH watcher terminated for ${key}:`, error)
  for (const listener of state.listeners.values()) {
    scheduleRemoteWatcherRetry(listener, connectionId, worktreePath)
  }
}

function scheduleRemoteWatcherRetry(
  sender: WebContents,
  connectionId: string,
  worktreePath: string,
  startedAt = Date.now()
): void {
  const key = remoteWatcherKey(connectionId, worktreePath)
  const existingRetry = pendingRemoteWatcherRetryListeners.get(key)
  if (existingRetry) {
    if (!sender.isDestroyed()) {
      existingRetry.listeners.set(sender.id, sender)
    }
    return
  }

  const retry = {
    listeners: new Map(sender.isDestroyed() ? [] : [[sender.id, sender]]),
    startedAt
  }
  pendingRemoteWatcherRetryListeners.set(key, retry)

  if (Date.now() - startedAt >= REMOTE_WATCH_RETRY_TIMEOUT_MS || sender.isDestroyed()) {
    pendingRemoteWatcherRetries.delete(key)
    pendingRemoteWatcherRetryListeners.delete(key)
    loggedUnavailableRemoteWatchers.delete(key)
    // Why: handler already resolved so the renderer thinks the watch is live; emit overflow to force a manual refresh instead of waiting forever.
    for (const listener of retry.listeners.values()) {
      if (listener.isDestroyed()) {
        continue
      }
      console.warn(
        `[filesystem-watcher] giving up SSH watch retry for ${worktreePath} on connection ${connectionId} after ${REMOTE_WATCH_RETRY_TIMEOUT_MS}ms`
      )
      listener.send('fs:changed', {
        worktreePath,
        events: [{ kind: 'overflow', absolutePath: worktreePath }]
      } satisfies FsChangedPayload)
    }
    return
  }

  const retryTimer = setTimeout(() => {
    pendingRemoteWatcherRetries.delete(key)
    pendingRemoteWatcherRetryListeners.delete(key)
    const listeners = Array.from(retry.listeners.values()).filter(
      (listener) => !listener.isDestroyed()
    )
    void Promise.all(
      listeners.map((listener) => installRemoteWatcher(listener, connectionId, worktreePath))
    )
      .then((results) => {
        // Why: don't re-arm on 'cancelled' (renderer stopped watching) — it would fire a stale overflow when the 60s window expires.
        if (results.some((result) => result === 'unavailable')) {
          for (const listener of listeners) {
            scheduleRemoteWatcherRetry(listener, connectionId, worktreePath, retry.startedAt)
          }
        }
      })
      .catch((error: unknown) => {
        if (isWatcherRemovalInProgressError(error)) {
          return
        }
        for (const listener of listeners) {
          scheduleRemoteWatcherRetry(listener, connectionId, worktreePath, retry.startedAt)
        }
      })
  }, REMOTE_WATCH_RETRY_MS)
  pendingRemoteWatcherRetries.set(key, retryTimer)
}

// ── Public API ───────────────────────────────────────────────────────

export function registerFilesystemWatcherHandlers(): void {
  ipcMain.handle(
    'fs:watchWorktree',
    async (event, args: { worktreePath: string; connectionId?: string }): Promise<void> => {
      if (args.connectionId) {
        // Why: a real new watch reopens the subsystem after closeAllWatchers latched it shut (also resets tests between cases).
        remoteWatchersClosed = false
        const key = remoteWatcherKey(args.connectionId, args.worktreePath)
        const result = await installRemoteWatcher(
          event.sender,
          args.connectionId,
          args.worktreePath
        )
        if (result === 'unavailable') {
          if (!loggedUnavailableRemoteWatchers.has(key)) {
            loggedUnavailableRemoteWatchers.add(key)
            console.warn(
              `[filesystem-watcher] SSH filesystem provider unavailable; retrying watch for ${args.worktreePath} on connection ${args.connectionId}`
            )
          }
          scheduleRemoteWatcherRetry(event.sender, args.connectionId, args.worktreePath)
          return
        }
        return
      }
      // Why: reopen the local subsystem for tests and post-shutdown reattachment; stale callers keep the prior generation.
      localWatchersClosed = false
      await subscribe(args.worktreePath, event.sender)
    }
  )

  ipcMain.handle(
    'fs:unwatchWorktree',
    (_event, args: { worktreePath: string; connectionId?: string }): void => {
      if (args.connectionId) {
        const key = remoteWatcherKey(args.connectionId, args.worktreePath)
        const suspended = suspendedRemoteWatcherListeners.get(key)
        suspended?.listeners.delete(_event.sender.id)
        if (suspended?.listeners.size === 0) {
          suspendedRemoteWatcherListeners.delete(key)
        }
        const retry = pendingRemoteWatcherRetryListeners.get(key)
        retry?.listeners.delete(_event.sender.id)
        const retryTimer = pendingRemoteWatcherRetries.get(key)
        if (retryTimer && retry?.listeners.size === 0) {
          clearTimeout(retryTimer)
          pendingRemoteWatcherRetries.delete(key)
          pendingRemoteWatcherRetryListeners.delete(key)
        }
        // Why: a retry-tick provider.watch() may still be in flight; mark cancelled so its resolved unwatch handle is discarded.
        const inFlight = inFlightRemoteInstalls.get(key)
        if (inFlight) {
          inFlight.listeners.delete(_event.sender.id)
          cancelInFlightRemoteInstallIfUnowned(inFlight)
        }
        loggedUnavailableRemoteWatchers.delete(key)
        releaseRemoteWatchListener(key, _event?.sender?.id ?? 0)
        return
      }
      const senderId = _event.sender.id
      unsubscribe(args.worktreePath, senderId)
    }
  )
}

function remoteWatcherKey(connectionId: string, worktreePath: string): string {
  return JSON.stringify([connectionId, normalizeRuntimePathForComparison(worktreePath)])
}

/** Tear down all watchers on app shutdown. */
export async function closeAllWatchers(): Promise<void> {
  senderCleanupRegistered.clear()
  unwatchableRoots.clear()
  suspendedLocalWatcherListeners.clear()
  suspendedRemoteWatcherListeners.clear()
  for (const retry of pendingLocalCapacityRetries.values()) {
    retry.cancelWait()
  }
  pendingLocalCapacityRetries.clear()

  // Cancel any pending grace-period teardowns — we're tearing down everything.
  for (const timer of pendingTeardowns.values()) {
    clearTimeout(timer)
  }
  pendingTeardowns.clear()

  for (const timer of pendingRemoteWatcherRetries.values()) {
    clearTimeout(timer)
  }
  pendingRemoteWatcherRetries.clear()
  pendingRemoteWatcherRetryListeners.clear()
  loggedUnavailableRemoteWatchers.clear()
  // Why: latch both subsystems shut so late installs can't register; generation bumps reject older-lifecycle waiters.
  remoteWatchersClosed = true
  remoteWatcherLifecycleGeneration += 1
  localWatchersClosed = true
  localWatcherLifecycleGeneration += 1
  pendingRemoteInstallPromises.clear()
  // Why: cancel in-flight provider.watch() calls so their resolved unwatch handles aren't installed post-shutdown.
  for (const token of inFlightRemoteInstalls.values()) {
    token.listeners.clear()
    token.cancelled = true
    token.abortController.abort()
  }
  for (const token of inFlightLocalInstalls.values()) {
    token.listeners.clear()
    token.cancelled = true
    token.abortController.abort()
  }

  for (const [rootKey, root] of watchedRoots) {
    if (root.batch.timer) {
      clearTimeout(root.batch.timer)
    }
    await trackLocalUnsubscribe(rootKey, root).catch(() => undefined)
  }
  watchedRoots.clear()
  await Promise.allSettled(Array.from(pendingLocalUnsubscribes))
  failedLocalUnsubscribes.clear()
  // Why: kill the forked watcher process instead of watcher.node's crash-prone async teardown; process death frees native handles.
  disposeWatcherProcess()

  // Why: remote watchers are separate from local @parcel/watcher subs; unwatch here or the relay keeps polling FS after shutdown.
  for (const [key, state] of remoteWatchers) {
    try {
      state.unwatch()
    } catch (err) {
      console.error(`[filesystem-watcher] remote unwatch error for ${key}:`, err)
    }
  }
  remoteWatchers.clear()
}
