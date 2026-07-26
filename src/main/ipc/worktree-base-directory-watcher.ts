import type { BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import { notifyWorktreeGitStatusMetadataChanged, notifyWorktreesChanged } from './worktree-remote'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import {
  createWorktreeHeadIdentityRefreshState,
  refreshWorktreeHeadIdentities,
  type WorktreeHeadIdentityRefreshState
} from './worktree-head-identity-refresh'
import {
  collectLocalWorktreeBaseChanges,
  collectRemoteWorktreeBaseChanges,
  type WorktreeBaseCollectedChanges
} from './worktree-base-directory-change-collector'
import type { WorktreeBaseWatchTarget } from './worktree-base-directory-event-filter'
import {
  buildWorktreeBaseDirectoryWatchTargets,
  clearWorktreeBaseDirectoryWatchTargetWarnings
} from './worktree-base-directory-watch-targets'
import {
  createWorktreePollerWindowVisibility,
  startWorktreeBaseDirectoryPoller
} from './worktree-base-directory-poller'

type ActiveWatch = WorktreeBaseWatchTarget & {
  mainWindow: BrowserWindow
  subscription: { unsubscribe: () => Promise<void> }
  notifyTimer: ReturnType<typeof setTimeout> | null
  pendingStructureRepoIds: Set<string>
  pendingGitStatusRepoIds: Set<string>
  pendingHeadIdentityRepoIds: Set<string>
  headIdentityRefresh: WorktreeHeadIdentityRefreshState
  disposed: boolean
}

const WATCH_DEBOUNCE_MS = 250
const activeWatches = new Map<string, ActiveWatch>()
let syncGeneration = 0
let scheduledSync: ReturnType<typeof setTimeout> | null = null
let latestSyncContext: { mainWindow: BrowserWindow; store: Store } | null = null

function clearPendingRepoIds(watch: ActiveWatch): void {
  watch.pendingStructureRepoIds.clear()
  watch.pendingGitStatusRepoIds.clear()
  watch.pendingHeadIdentityRepoIds.clear()
}

type PendingNotificationInput = Partial<Omit<WorktreeBaseCollectedChanges, 'overflow'>>

function scheduleNotification(watch: ActiveWatch, changes: PendingNotificationInput): void {
  if (watch.disposed || watch.mainWindow.isDestroyed()) {
    clearPendingRepoIds(watch)
    return
  }
  for (const repoId of changes.structureRepoIds ?? []) {
    watch.pendingStructureRepoIds.add(repoId)
  }
  for (const repoId of changes.gitStatusRepoIds ?? []) {
    watch.pendingGitStatusRepoIds.add(repoId)
  }
  for (const repoId of changes.headIdentityRepoIds ?? []) {
    watch.pendingHeadIdentityRepoIds.add(repoId)
  }
  // clearTimeout tolerates null (no-op), so no guard needed before rescheduling.
  clearTimeout(watch.notifyTimer ?? undefined)
  watch.notifyTimer = setTimeout(() => {
    watch.notifyTimer = null
    if (watch.disposed || watch.mainWindow.isDestroyed()) {
      clearPendingRepoIds(watch)
      return
    }
    const pendingStructure = [...watch.pendingStructureRepoIds]
    const hasHeadIdentity = watch.pendingHeadIdentityRepoIds.size > 0
    // Source Control refreshes on both index churn and head moves; structural
    // repos already refresh via the authoritative listing, so drop them here.
    const sourceControlRepoIds = new Set(
      [...watch.pendingGitStatusRepoIds, ...watch.pendingHeadIdentityRepoIds].filter(
        (repoId) => !watch.pendingStructureRepoIds.has(repoId)
      )
    )
    // Structural ticks refresh silently (emit=false): the authoritative listing
    // already reported them, so this only re-baselines ahead of later head diffs.
    const emitHeadIdentities = pendingStructure.length === 0
    clearPendingRepoIds(watch)
    for (const repoId of pendingStructure) {
      notifyWorktreesChanged(watch.mainWindow, repoId)
    }
    for (const repoId of sourceControlRepoIds) {
      notifyWorktreeGitStatusMetadataChanged(watch.mainWindow, repoId)
    }
    // Only re-read head identities for true head triggers: an index rewrite
    // cannot move HEAD, so status-only bursts skip the linked-worktree scan.
    if (supportsHeadIdentityRefresh(watch) && (pendingStructure.length > 0 || hasHeadIdentity)) {
      void refreshWorktreeHeadIdentities(watch, watch.headIdentityRefresh, emitHeadIdentities)
    }
  }, WATCH_DEBOUNCE_MS)
}

// Why: SSH common dirs would need per-signal network reads to diff heads;
// remote background freshness stays on the structural path for now.
function supportsHeadIdentityRefresh(watch: ActiveWatch): boolean {
  return watch.kind === 'git-common' && !watch.connectionId
}

function hasCollectedChanges(changes: WorktreeBaseCollectedChanges): boolean {
  return [changes.structureRepoIds, changes.gitStatusRepoIds, changes.headIdentityRepoIds].some(
    (ids) => ids.length > 0
  )
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
    scheduleNotification(watch, { structureRepoIds: [...watch.repos.keys()] })
    return
  }
  const changes = collectLocalWorktreeBaseChanges(watch, events)
  if (hasCollectedChanges(changes)) {
    scheduleNotification(watch, changes)
  }
}

function handleRemoteWatchEvents(
  watch: ActiveWatch,
  events: Parameters<typeof collectRemoteWorktreeBaseChanges>[1]
): void {
  if (watch.disposed || watch.mainWindow.isDestroyed()) {
    return
  }
  const changes = collectRemoteWorktreeBaseChanges(watch, events)
  if (changes.overflow) {
    scheduleNotification(watch, { structureRepoIds: [...watch.repos.keys()] })
    return
  }
  if (hasCollectedChanges(changes)) {
    scheduleNotification(watch, changes)
  }
}

function createActiveWatch(
  target: WorktreeBaseWatchTarget,
  mainWindow: BrowserWindow,
  subscription: ActiveWatch['subscription']
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
    disposed: false
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
    activeWatch = createActiveWatch(target, mainWindow, {
      unsubscribe: async () => unwatch()
    })
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
      )
    }
  )
  activeWatch = createActiveWatch(target, mainWindow, subscription)
  if (supportsHeadIdentityRefresh(activeWatch)) {
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
  clearTimeout(watch.notifyTimer ?? undefined)
  clearPendingRepoIds(watch)
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
