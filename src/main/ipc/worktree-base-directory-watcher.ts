import type { BrowserWindow } from 'electron'
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
import { clearWorktreeBaseDirectoryWatchTargetCache } from './worktree-base-directory-watch-target-cache'
import { clearWorktreeBaseDirectoryWatchTargetWarnings } from './worktree-base-directory-watch-targets'
import {
  reconcileWorktreeBaseDirectoryWatchers,
  type WorktreeBaseDirectoryWatchReplacementResult
} from './worktree-base-directory-watcher-reconciler'
import { WorktreeBaseDirectoryWatcherRetries } from './worktree-base-directory-watcher-retries'
import { createWorktreeBaseDirectoryWatcherSync } from './worktree-base-directory-watcher-sync'
import type { PendingWorktreeBaseDirectoryWatcherSync } from './worktree-base-directory-watcher-sync-queue'
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

type ReplaceWatchResult = WorktreeBaseDirectoryWatchReplacementResult

async function disposeWatch(watch: ActiveWatch): Promise<void> {
  watch.disposed = true
  clearTimeout(watch.notifyTimer ?? undefined)
  clearPendingWorktreeBaseNotifications(watch)
  await watch.subscription.unsubscribe().catch((error) => {
    console.warn(`[worktree-base-watcher] failed to unwatch ${watch.path}:`, error)
  })
}

async function replaceWatch(
  target: WorktreeBaseWatchTarget,
  mainWindow: BrowserWindow,
  signal: AbortSignal
): Promise<ReplaceWatchResult> {
  const previous = activeWatches.get(target.key)
  if (previous) {
    // Keep the surviving subscription's routing current while a replacement is pending.
    previous.repos = target.repos
    previous.mainWindow = mainWindow
    applyActiveGitStatusRefBinding(previous)
    if (previous.providerGeneration === target.providerGeneration) {
      return 'ready'
    }
  }
  try {
    const activeWatch = await subscribeTarget(target, mainWindow)
    if (signal.aborted) {
      await disposeWatch(activeWatch)
      return 'stale'
    }
    applyActiveGitStatusRefBinding(activeWatch)
    activeWatches.set(target.key, activeWatch)
    if (previous) {
      await disposeWatch(previous)
      if (signal.aborted) {
        if (activeWatches.get(target.key) === activeWatch) {
          activeWatches.delete(target.key)
        }
        await disposeWatch(activeWatch)
        return 'stale'
      }
    }
    return 'ready'
  } catch (error) {
    if (!signal.aborted) {
      console.warn(`[worktree-base-watcher] failed to watch ${target.path}:`, error)
      return 'failed'
    }
    return 'stale'
  }
}

async function removeWatch(key: string): Promise<void> {
  const watch = activeWatches.get(key)
  if (!watch) {
    return
  }
  activeWatches.delete(key)
  await disposeWatch(watch)
}

function refreshRetainedWatch(
  key: string,
  repos: WorktreeBaseWatchTarget['repos'],
  mainWindow: BrowserWindow
): void {
  const watch = activeWatches.get(key)
  if (!watch) {
    return
  }
  watch.repos = repos
  watch.mainWindow = mainWindow
  applyActiveGitStatusRefBinding(watch)
}

async function runSyncPass(
  request: PendingWorktreeBaseDirectoryWatcherSync,
  signal: AbortSignal
): Promise<void> {
  watcherRetries.activate()
  if (request.mainWindow.isDestroyed()) {
    return
  }
  try {
    await reconcileWorktreeBaseDirectoryWatchers(
      request,
      signal,
      activeWatches,
      watcherRetries,
      (target, replacementSignal) => replaceWatch(target, request.mainWindow, replacementSignal),
      removeWatch,
      (key, repos) => refreshRetainedWatch(key, repos, request.mainWindow)
    )
  } catch (error) {
    if (!signal.aborted) {
      console.warn('[worktree-base-watcher] failed to synchronize watch targets:', error)
    }
  }
}

const watcherSync = createWorktreeBaseDirectoryWatcherSync(runSyncPass)
const watcherRetries = new WorktreeBaseDirectoryWatcherRetries((store, mainWindow, identities) => {
  void watcherSync.sync(store, mainWindow, { dirtyRepoIdentities: identities })
})

export const syncWorktreeBaseDirectoryWatchers = watcherSync.sync
export const setWorktreeBaseDirectoryWatcherSyncContext = watcherSync.setContext
export const scheduleWorktreeBaseDirectoryWatcherSync = watcherSync.schedule
export const scheduleCurrentWorktreeBaseDirectoryWatcherSync = watcherSync.scheduleCurrent

export async function disposeWorktreeBaseDirectoryWatchers(): Promise<void> {
  clearActiveGitStatusRefBinding()
  watcherRetries.dispose()
  await watcherSync.dispose()
  await Promise.all([...activeWatches.keys()].map((key) => removeWatch(key)))
  clearWorktreeBaseDirectoryWatchTargetCache()
  clearWorktreeBaseDirectoryWatchTargetWarnings()
}
