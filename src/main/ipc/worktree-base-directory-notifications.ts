import type { BrowserWindow } from 'electron'
import type { WorktreeBaseCollectedChanges } from './worktree-base-directory-change-collector'
import type { WorktreeBaseWatchTarget } from './worktree-base-directory-event-filter'
import {
  refreshWorktreeHeadIdentities,
  type WorktreeHeadIdentityRefreshState
} from './worktree-head-identity-refresh'
import {
  EMPTY_HEAD_IDENTITY_SCOPE,
  FULL_HEAD_IDENTITY_SCOPE,
  mergeHeadIdentityScopes,
  type WorktreeHeadIdentityScope
} from './worktree-head-identity-scope'
import { notifyWorktreeGitStatusMetadataChanged } from './worktree-remote'
import { notifyWatchedWorktreeCatalogChanged } from './watched-worktree-catalog-notification'
import {
  isBackgroundWorkHeldForLocalCreates,
  whenLocalWorktreeCreatesSettle
} from '../git/local-worktree-create-activity'

export type WorktreeBaseNotificationWatch = WorktreeBaseWatchTarget & {
  mainWindow: BrowserWindow
  notifyTimer: ReturnType<typeof setTimeout> | null
  pendingStructureRepoIds: Set<string>
  pendingGitStatusRepoIds: Set<string>
  pendingHeadIdentityRepoIds: Set<string>
  pendingHeadIdentityScope: WorktreeHeadIdentityScope
  headIdentityRefresh: WorktreeHeadIdentityRefreshState
  disposed: boolean
  /** Set while structural changes wait for a local create to settle. */
  heldForLocalCreate?: boolean
}

const WATCH_DEBOUNCE_MS = 250

export function clearPendingWorktreeBaseNotifications(watch: WorktreeBaseNotificationWatch): void {
  watch.pendingStructureRepoIds.clear()
  watch.pendingGitStatusRepoIds.clear()
  watch.pendingHeadIdentityRepoIds.clear()
  watch.pendingHeadIdentityScope = EMPTY_HEAD_IDENTITY_SCOPE
}

export function supportsWorktreeHeadIdentityRefresh(watch: WorktreeBaseNotificationWatch): boolean {
  return watch.kind === 'git-common' && !watch.connectionId
}

export function scheduleWorktreeBaseNotification(
  watch: WorktreeBaseNotificationWatch,
  changes: Partial<Omit<WorktreeBaseCollectedChanges, 'overflow'>>
): void {
  if (watch.disposed || watch.mainWindow.isDestroyed()) {
    clearPendingWorktreeBaseNotifications(watch)
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
  // Why: callers that cannot attribute the burst to specific worktrees (watcher
  // failure, event overflow) omit the scope entirely; that is a loss of
  // knowledge, so it must widen to a full re-read rather than narrow to nothing.
  watch.pendingHeadIdentityScope = mergeHeadIdentityScopes(
    watch.pendingHeadIdentityScope,
    changes.headIdentityScope ?? FULL_HEAD_IDENTITY_SCOPE
  )
  clearTimeout(watch.notifyTimer ?? undefined)
  watch.notifyTimer = setTimeout(() => {
    watch.notifyTimer = null
    const holdStructure =
      !watch.connectionId &&
      watch.pendingStructureRepoIds.size > 0 &&
      isBackgroundWorkHeldForLocalCreates()
    flushWorktreeBaseNotification(watch, holdStructure)
    if (holdStructure) {
      flushStructureWhenLocalCreatesSettle(watch)
    }
  }, WATCH_DEBOUNCE_MS)
}

/**
 * A structural change fans out to full re-lists of every worktree in the repo. While a local
 * create is checking out, keep collecting those changes and deliver them once, when it settles
 * (or at the deadline). Status and head identity changes still go out at once.
 */
function flushStructureWhenLocalCreatesSettle(watch: WorktreeBaseNotificationWatch): void {
  if (watch.heldForLocalCreate) {
    return
  }
  watch.heldForLocalCreate = true
  void whenLocalWorktreeCreatesSettle().then(() => {
    watch.heldForLocalCreate = false
    flushWorktreeBaseNotification(watch, false)
  })
}

function flushWorktreeBaseNotification(
  watch: WorktreeBaseNotificationWatch,
  holdStructure: boolean
): void {
  if (watch.disposed || watch.mainWindow.isDestroyed()) {
    clearPendingWorktreeBaseNotifications(watch)
    return
  }
  const pendingStructure = holdStructure ? [] : [...watch.pendingStructureRepoIds]
  const sourceControlRepoIds = new Set(
    [...watch.pendingGitStatusRepoIds, ...watch.pendingHeadIdentityRepoIds].filter(
      (repoId) => !pendingStructure.includes(repoId)
    )
  )
  const refreshHeadIdentities =
    supportsWorktreeHeadIdentityRefresh(watch) &&
    (pendingStructure.length > 0 || watch.pendingHeadIdentityRepoIds.size > 0)
  const emitHeadIdentities = pendingStructure.length === 0
  const headIdentityScope = watch.pendingHeadIdentityScope
  watch.pendingGitStatusRepoIds.clear()
  watch.pendingHeadIdentityRepoIds.clear()
  if (!holdStructure) {
    watch.pendingStructureRepoIds.clear()
  }
  // A held structural change keeps its scope for the re-read on delivery, unless the head refresh below takes it now.
  if (!holdStructure || refreshHeadIdentities) {
    watch.pendingHeadIdentityScope = EMPTY_HEAD_IDENTITY_SCOPE
  }
  for (const repoId of pendingStructure) {
    notifyWatchedWorktreeCatalogChanged(watch.mainWindow, repoId, watch.connectionId)
  }
  for (const repoId of sourceControlRepoIds) {
    notifyWorktreeGitStatusMetadataChanged(watch.mainWindow, repoId)
  }
  if (refreshHeadIdentities) {
    void refreshWorktreeHeadIdentities(
      watch,
      watch.headIdentityRefresh,
      emitHeadIdentities,
      headIdentityScope
    )
  }
}
