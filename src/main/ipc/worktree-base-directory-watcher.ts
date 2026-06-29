import type { BrowserWindow } from 'electron'
import type { AsyncSubscription } from '@parcel/watcher'
import type { FsChangeEvent } from '../../shared/types'
import type { Store } from '../persistence'
import { notifyWorktreesChanged } from './worktree-remote'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import {
  matchingWorktreeBaseRepoIds,
  type WorktreeBaseWatchTarget
} from './worktree-base-directory-event-filter'
import {
  buildWorktreeBaseDirectoryWatchTargets,
  clearWorktreeBaseDirectoryWatchTargetWarnings
} from './worktree-base-directory-watch-targets'

type ActiveWatch = WorktreeBaseWatchTarget & {
  mainWindow: BrowserWindow
  subscription: Pick<AsyncSubscription, 'unsubscribe'>
  notifyTimer: ReturnType<typeof setTimeout> | null
  pendingRepoIds: Set<string>
  disposed: boolean
}

const WATCH_DEBOUNCE_MS = 250
const activeWatches = new Map<string, ActiveWatch>()
let syncGeneration = 0
let scheduledSync: ReturnType<typeof setTimeout> | null = null
let latestSyncContext: { mainWindow: BrowserWindow; store: Store } | null = null

function scheduleNotification(watch: ActiveWatch, repoIds: readonly string[]): void {
  if (watch.disposed || watch.mainWindow.isDestroyed()) {
    watch.pendingRepoIds.clear()
    return
  }
  for (const repoId of repoIds) {
    watch.pendingRepoIds.add(repoId)
  }
  if (watch.notifyTimer) {
    clearTimeout(watch.notifyTimer)
  }
  watch.notifyTimer = setTimeout(() => {
    watch.notifyTimer = null
    if (watch.disposed || watch.mainWindow.isDestroyed()) {
      watch.pendingRepoIds.clear()
      return
    }
    const pending = [...watch.pendingRepoIds]
    watch.pendingRepoIds.clear()
    for (const repoId of pending) {
      notifyWorktreesChanged(watch.mainWindow, repoId)
    }
  }, WATCH_DEBOUNCE_MS)
}

function collectMatchingRepoIds(
  watch: ActiveWatch,
  eventType: 'create' | 'update' | 'delete',
  eventPath: string,
  repoIds: Set<string>
): void {
  for (const repoId of matchingWorktreeBaseRepoIds(watch, { type: eventType, path: eventPath })) {
    repoIds.add(repoId)
  }
}

function handleLocalWatchEvents(
  watch: ActiveWatch,
  error: Error | null,
  events: { type: 'create' | 'update' | 'delete'; path: string }[]
): void {
  if (watch.disposed || watch.mainWindow.isDestroyed()) {
    return
  }
  if (error) {
    console.warn(`[worktree-base-watcher] watcher failed for ${watch.path}:`, error)
    scheduleNotification(watch, [...watch.repos.keys()])
    return
  }
  const repoIds = new Set<string>()
  for (const event of events) {
    collectMatchingRepoIds(watch, event.type, event.path, repoIds)
  }
  if (repoIds.size > 0) {
    scheduleNotification(watch, [...repoIds])
  }
}

function handleRemoteWatchEvents(watch: ActiveWatch, events: FsChangeEvent[]): void {
  if (watch.disposed || watch.mainWindow.isDestroyed()) {
    return
  }
  const repoIds = new Set<string>()
  for (const event of events) {
    if (event.kind === 'overflow') {
      scheduleNotification(watch, [...watch.repos.keys()])
      return
    }
    if (event.kind === 'rename') {
      if (event.oldAbsolutePath) {
        collectMatchingRepoIds(watch, 'delete', event.oldAbsolutePath, repoIds)
      }
      collectMatchingRepoIds(watch, 'create', event.absolutePath, repoIds)
      continue
    }
    collectMatchingRepoIds(watch, event.kind, event.absolutePath, repoIds)
  }
  if (repoIds.size > 0) {
    scheduleNotification(watch, [...repoIds])
  }
}

async function subscribeTarget(
  target: WorktreeBaseWatchTarget,
  mainWindow: BrowserWindow
): Promise<ActiveWatch> {
  let activeWatch: ActiveWatch | null = null
  if (target.connectionId) {
    const provider = getSshFilesystemProvider(target.connectionId)
    if (!provider) {
      throw new Error(`SSH filesystem provider unavailable for ${target.connectionId}`)
    }
    const unwatch = await provider.watch(target.path, (events) => {
      const currentWatch = activeWatches.get(target.key) ?? activeWatch
      if (!currentWatch || currentWatch.disposed) {
        return
      }
      handleRemoteWatchEvents(currentWatch, events)
    })
    activeWatch = {
      ...target,
      mainWindow,
      subscription: { unsubscribe: async () => unwatch() },
      notifyTimer: null,
      pendingRepoIds: new Set(),
      disposed: false
    }
    return activeWatch
  }

  const watcher = await import('@parcel/watcher')
  const subscription = await watcher.subscribe(
    target.path,
    (error, events) => {
      const currentWatch = activeWatches.get(target.key) ?? activeWatch
      if (!currentWatch || currentWatch.disposed) {
        return
      }
      handleLocalWatchEvents(currentWatch, error, events)
    },
    {
      ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.next/**', '**/.cache/**'],
      ...(process.platform === 'win32' ? { backend: 'windows' as const } : {})
    }
  )
  activeWatch = {
    ...target,
    mainWindow,
    subscription,
    notifyTimer: null,
    pendingRepoIds: new Set(),
    disposed: false
  }
  return activeWatch
}

async function replaceWatch(
  target: WorktreeBaseWatchTarget,
  mainWindow: BrowserWindow,
  generation: number
): Promise<void> {
  const previous = activeWatches.get(target.key)
  if (previous) {
    previous.repos = target.repos
    previous.mainWindow = mainWindow
    return
  }
  try {
    const activeWatch = await subscribeTarget(target, mainWindow)
    if (generation !== syncGeneration) {
      activeWatch.disposed = true
      await activeWatch.subscription.unsubscribe().catch((error) => {
        console.warn(`[worktree-base-watcher] failed to unwatch stale ${target.path}:`, error)
      })
      return
    }
    activeWatches.set(target.key, activeWatch)
  } catch (error) {
    console.warn(`[worktree-base-watcher] failed to watch ${target.path}:`, error)
  }
}

async function removeWatch(key: string): Promise<void> {
  const watch = activeWatches.get(key)
  if (!watch) {
    return
  }
  activeWatches.delete(key)
  watch.disposed = true
  if (watch.notifyTimer) {
    clearTimeout(watch.notifyTimer)
  }
  await watch.subscription.unsubscribe().catch((error) => {
    console.warn(`[worktree-base-watcher] failed to unwatch ${watch.path}:`, error)
  })
}

export async function syncWorktreeBaseDirectoryWatchers(
  store: Store,
  mainWindow: BrowserWindow
): Promise<void> {
  const generation = ++syncGeneration
  const targets = await buildWorktreeBaseDirectoryWatchTargets(store)
  if (generation !== syncGeneration) {
    return
  }
  for (const key of activeWatches.keys()) {
    if (generation !== syncGeneration) {
      return
    }
    if (!targets.has(key)) {
      await removeWatch(key)
      if (generation !== syncGeneration) {
        return
      }
    }
  }
  for (const target of targets.values()) {
    if (generation !== syncGeneration) {
      return
    }
    await replaceWatch(target, mainWindow, generation)
    if (generation !== syncGeneration) {
      return
    }
  }
}

export function setWorktreeBaseDirectoryWatcherSyncContext(
  store: Store,
  mainWindow: BrowserWindow
): void {
  latestSyncContext = { store, mainWindow }
  // Why: older integration tests use lean BrowserWindow stubs; real windows still
  // clear this context on close so stale watcher syncs cannot target dead chrome.
  if (typeof mainWindow.once === 'function') {
    mainWindow.once('closed', () => {
      if (latestSyncContext?.mainWindow === mainWindow) {
        latestSyncContext = null
      }
    })
  }
}

export function scheduleWorktreeBaseDirectoryWatcherSync(
  store: Store,
  mainWindow: BrowserWindow
): void {
  if (scheduledSync) {
    clearTimeout(scheduledSync)
  }
  scheduledSync = setTimeout(() => {
    scheduledSync = null
    if (mainWindow.isDestroyed()) {
      return
    }
    void syncWorktreeBaseDirectoryWatchers(store, mainWindow)
  }, 100)
}

export function scheduleCurrentWorktreeBaseDirectoryWatcherSync(): void {
  if (!latestSyncContext || latestSyncContext.mainWindow.isDestroyed()) {
    return
  }
  scheduleWorktreeBaseDirectoryWatcherSync(latestSyncContext.store, latestSyncContext.mainWindow)
}

export async function disposeWorktreeBaseDirectoryWatchers(): Promise<void> {
  syncGeneration++
  latestSyncContext = null
  if (scheduledSync) {
    clearTimeout(scheduledSync)
    scheduledSync = null
  }
  await Promise.all([...activeWatches.keys()].map((key) => removeWatch(key)))
  clearWorktreeBaseDirectoryWatchTargetWarnings()
}
