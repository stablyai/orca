import type { BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import {
  createWorktreeHeadIdentityRefreshState,
  refreshWorktreeHeadIdentities,
  type WorktreeHeadIdentityRefreshState
} from './worktree-head-identity-refresh'
import {
  collectLocalWorktreeBaseChanges,
  collectRemoteWorktreeBaseChanges,
  hasCollectedWorktreeBaseChanges
} from './worktree-base-directory-change-collector'
import {
  clearPendingWorktreeBaseNotifications,
  scheduleWorktreeBaseNotification,
  supportsWorktreeHeadIdentityRefresh
} from './worktree-base-directory-notifications'
import type { WorktreeBaseWatchTarget } from './worktree-base-directory-event-filter'
import {
  buildWorktreeBaseDirectoryWatchTargets,
  clearWorktreeBaseDirectoryWatchTargetWarnings
} from './worktree-base-directory-watch-targets'
import {
  createWorktreePollerWindowVisibility,
  startWorktreeBaseDirectoryPoller
} from './worktree-base-directory-poller'
import {
  applyActiveGitStatusRefBinding,
  clearActiveGitStatusRefBinding,
  invalidateActiveGitStatusRefResolution,
  invalidateGitStatusRefResolutionForPaths,
  updateActiveGitStatusRefBinding,
  type GitStatusRefBindingRequest
} from './worktree-git-status-ref-watch'
import { WorktreeWatcherFailureRefreshCooldown } from './worktree-watcher-failure-refresh-cooldown'

type ActiveWatch = WorktreeBaseWatchTarget & {
  mainWindow: BrowserWindow
  subscription: { unsubscribe: () => Promise<void> }
  notifyTimer: ReturnType<typeof setTimeout> | null
  pendingStructureRepoIds: Set<string>
  pendingGitStatusRepoIds: Set<string>
  pendingHeadIdentityRepoIds: Set<string>
  headIdentityRefresh: WorktreeHeadIdentityRefreshState
  gitStatusRefPaths: Set<string>
  watcherFailureRefresh: WorktreeWatcherFailureRefreshCooldown
  disposed: boolean
}

const activeWatches = new Map<string, ActiveWatch>()
let syncGeneration = 0
let scheduledSync: ReturnType<typeof setTimeout> | null = null
let latestSyncContext: { mainWindow: BrowserWindow; store: Store } | null = null
export function setWorktreeGitStatusRefWatch(
  args: GitStatusRefBindingRequest,
  resolveUpstreamRef: (signal: AbortSignal) => Promise<string | undefined>
): Promise<void> {
  return updateActiveGitStatusRefBinding(args, () => activeWatches.values(), resolveUpstreamRef)
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
    invalidateActiveGitStatusRefResolution(watch, () => activeWatches.values())
    if (watch.watcherFailureRefresh.consume()) {
      scheduleWorktreeBaseNotification(watch, { structureRepoIds: [...watch.repos.keys()] })
    }
    return
  }
  watch.watcherFailureRefresh.reset()
  invalidateGitStatusRefResolutionForPaths(
    watch,
    events.map((event) => event.path),
    () => activeWatches.values()
  )
  const changes = collectLocalWorktreeBaseChanges(watch, events)
  if (hasCollectedWorktreeBaseChanges(changes)) {
    scheduleWorktreeBaseNotification(watch, changes)
  }
}

function handleRemoteWatchEvents(
  watch: ActiveWatch,
  events: Parameters<typeof collectRemoteWorktreeBaseChanges>[1]
): void {
  if (watch.disposed || watch.mainWindow.isDestroyed()) {
    return
  }
  invalidateGitStatusRefResolutionForPaths(
    watch,
    events.flatMap((event) =>
      event.kind === 'overflow' ? [] : [event.absolutePath, event.oldAbsolutePath]
    ),
    () => activeWatches.values()
  )
  const changes = collectRemoteWorktreeBaseChanges(watch, events)
  if (changes.overflow) {
    invalidateActiveGitStatusRefResolution(watch, () => activeWatches.values())
    scheduleWorktreeBaseNotification(watch, { structureRepoIds: [...watch.repos.keys()] })
    return
  }
  if (hasCollectedWorktreeBaseChanges(changes)) {
    scheduleWorktreeBaseNotification(watch, changes)
  }
}

function createActiveWatch(
  target: WorktreeBaseWatchTarget,
  mainWindow: BrowserWindow,
  subscription: ActiveWatch['subscription'],
  gitStatusRefPaths: Set<string>
): ActiveWatch {
  return {
    ...target,
    mainWindow,
    subscription,
    notifyTimer: null,
    pendingStructureRepoIds: new Set(),
    pendingGitStatusRepoIds: new Set(),
    pendingHeadIdentityRepoIds: new Set(),
    headIdentityRefresh: createWorktreeHeadIdentityRefreshState(),
    gitStatusRefPaths,
    watcherFailureRefresh: new WorktreeWatcherFailureRefreshCooldown(),
    disposed: false
  }
}

async function subscribeTarget(
  target: WorktreeBaseWatchTarget,
  mainWindow: BrowserWindow
): Promise<ActiveWatch> {
  let activeWatch: ActiveWatch | null = null
  const gitStatusRefPaths = new Set<string>()
  applyActiveGitStatusRefBinding({ ...target, gitStatusRefPaths })
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
    activeWatch = createActiveWatch(
      target,
      mainWindow,
      { unsubscribe: async () => unwatch() },
      gitStatusRefPaths
    )
    return activeWatch
  }

  // Why: a recursive native watcher here forced fseventsd to deliver every
  // event under the whole workspace root (all worktrees) / whole common .git
  // (objects included) just to observe a few shallow paths. The poller reads
  // exactly those paths and registers zero fseventsd clients.
  const subscription = await startWorktreeBaseDirectoryPoller(
    target,
    () => (activeWatches.get(target.key) ?? activeWatch)?.repos ?? target.repos,
    (events) => {
      const currentWatch = activeWatches.get(target.key) ?? activeWatch
      if (currentWatch && !currentWatch.disposed) {
        handleLocalWatchEvents(currentWatch, null, events)
      }
    },
    {
      visibility: createWorktreePollerWindowVisibility(
        () => (activeWatches.get(target.key) ?? activeWatch)?.mainWindow ?? null
      ),
      getGitStatusRefPaths: () => [...gitStatusRefPaths],
      onWatchError: (error) => {
        const currentWatch = activeWatches.get(target.key) ?? activeWatch
        if (currentWatch && !currentWatch.disposed) {
          handleLocalWatchEvents(currentWatch, error, [])
        }
      }
    }
  )
  activeWatch = createActiveWatch(target, mainWindow, subscription, gitStatusRefPaths)
  if (supportsWorktreeHeadIdentityRefresh(activeWatch)) {
    // Baseline eagerly so the first status-only signal — possibly hours after
    // subscribe — diffs against subscribe-time heads instead of silently
    // re-baselining past an external commit.
    void refreshWorktreeHeadIdentities(activeWatch, activeWatch.headIdentityRefresh, false)
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
    applyActiveGitStatusRefBinding(previous)
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
    applyActiveGitStatusRefBinding(activeWatch)
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
  clearTimeout(watch.notifyTimer ?? undefined)
  clearPendingWorktreeBaseNotifications(watch)
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
  clearActiveGitStatusRefBinding()
  if (scheduledSync) {
    clearTimeout(scheduledSync)
    scheduledSync = null
  }
  await Promise.all([...activeWatches.keys()].map((key) => removeWatch(key)))
  clearWorktreeBaseDirectoryWatchTargetWarnings()
}
