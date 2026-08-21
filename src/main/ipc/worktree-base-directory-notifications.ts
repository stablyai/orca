import type { BrowserWindow } from 'electron'
import type { WorktreeBaseCollectedChanges } from './worktree-base-directory-change-collector'
import type { WorktreeBaseWatchTarget } from './worktree-base-directory-event-filter'
import {
  refreshWorktreeHeadIdentities,
  type WorktreeHeadIdentityRefreshState
} from './worktree-head-identity-refresh'
import { notifyWorktreeGitStatusMetadataChanged, notifyWorktreesChanged } from './worktree-remote'

export type WorktreeBaseNotificationWatch = WorktreeBaseWatchTarget & {
  mainWindow: BrowserWindow
  notifyTimer: ReturnType<typeof setTimeout> | null
  pendingStructureRepoIds: Set<string>
  pendingGitStatusRepoIds: Set<string>
  pendingHeadIdentityRepoIds: Set<string>
  headIdentityRefresh: WorktreeHeadIdentityRefreshState
  disposed: boolean
}

const WATCH_DEBOUNCE_MS = 250

export function clearPendingWorktreeBaseNotifications(watch: WorktreeBaseNotificationWatch): void {
  watch.pendingStructureRepoIds.clear()
  watch.pendingGitStatusRepoIds.clear()
  watch.pendingHeadIdentityRepoIds.clear()
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
  clearTimeout(watch.notifyTimer ?? undefined)
  watch.notifyTimer = setTimeout(() => {
    watch.notifyTimer = null
    if (watch.disposed || watch.mainWindow.isDestroyed()) {
      clearPendingWorktreeBaseNotifications(watch)
      return
    }
    const pendingStructure = [...watch.pendingStructureRepoIds]
    const hasHeadIdentity = watch.pendingHeadIdentityRepoIds.size > 0
    const sourceControlRepoIds = new Set(
      [...watch.pendingGitStatusRepoIds, ...watch.pendingHeadIdentityRepoIds].filter(
        (repoId) => !watch.pendingStructureRepoIds.has(repoId)
      )
    )
    const emitHeadIdentities = pendingStructure.length === 0
    clearPendingWorktreeBaseNotifications(watch)
    for (const repoId of pendingStructure) {
      notifyWorktreesChanged(watch.mainWindow, repoId)
    }
    for (const repoId of sourceControlRepoIds) {
      notifyWorktreeGitStatusMetadataChanged(watch.mainWindow, repoId)
    }
    if (
      supportsWorktreeHeadIdentityRefresh(watch) &&
      (pendingStructure.length > 0 || hasHeadIdentity)
    ) {
      void refreshWorktreeHeadIdentities(watch, watch.headIdentityRefresh, emitHeadIdentities)
    }
  }, WATCH_DEBOUNCE_MS)
}
