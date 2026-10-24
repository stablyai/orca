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
import { cachedWorktreePathsForScope } from './worktree-head-identity-cached-paths'
import { notifyWorktreeGitStatusMetadataChanged } from './worktree-remote'
import { notifyWatchedWorktreeCatalogChanged } from './watched-worktree-catalog-notification'

export type WorktreeBaseNotificationWatch = WorktreeBaseWatchTarget & {
  mainWindow: BrowserWindow
  notifyTimer: ReturnType<typeof setTimeout> | null
  pendingStructureRepoIds: Set<string>
  pendingGitStatusRepoIds: Set<string>
  pendingHeadIdentityRepoIds: Set<string>
  pendingHeadIdentityScope: WorktreeHeadIdentityScope
  pendingGitStatusScope: WorktreeHeadIdentityScope
  headIdentityRefresh: WorktreeHeadIdentityRefreshState
  disposed: boolean
}

const WATCH_DEBOUNCE_MS = 250

export function clearPendingWorktreeBaseNotifications(watch: WorktreeBaseNotificationWatch): void {
  watch.pendingStructureRepoIds.clear()
  watch.pendingGitStatusRepoIds.clear()
  watch.pendingHeadIdentityRepoIds.clear()
  watch.pendingHeadIdentityScope = EMPTY_HEAD_IDENTITY_SCOPE
  watch.pendingGitStatusScope = EMPTY_HEAD_IDENTITY_SCOPE
}

export function supportsWorktreeHeadIdentityRefresh(watch: WorktreeBaseNotificationWatch): boolean {
  return watch.kind === 'git-common'
}

export function scheduleWorktreeBaseNotification(
  watch: WorktreeBaseNotificationWatch,
  changes: Partial<WorktreeBaseCollectedChanges>
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
  // Unattributed bursts lose knowledge; widen to all heads rather than narrowing to none.
  watch.pendingHeadIdentityScope = mergeHeadIdentityScopes(
    watch.pendingHeadIdentityScope,
    changes.headIdentityScope ?? FULL_HEAD_IDENTITY_SCOPE
  )
  watch.pendingGitStatusScope = mergeHeadIdentityScopes(
    watch.pendingGitStatusScope,
    changes.gitStatusScope ?? FULL_HEAD_IDENTITY_SCOPE
  )
  // Sustained churn joins the armed notification without postponing delivery.
  if (watch.notifyTimer) {
    return
  }
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
    const headIdentityScope = watch.pendingHeadIdentityScope
    // Resolve attribution before head refresh rewrites the memo; base watches remain unattributed.
    const gitStatusWorktreePaths = supportsWorktreeHeadIdentityRefresh(watch)
      ? cachedWorktreePathsForScope(watch.headIdentityRefresh.cache, watch.pendingGitStatusScope)
      : null
    clearPendingWorktreeBaseNotifications(watch)
    for (const repoId of pendingStructure) {
      notifyWatchedWorktreeCatalogChanged(watch.mainWindow, repoId)
    }
    for (const repoId of sourceControlRepoIds) {
      notifyWorktreeGitStatusMetadataChanged(watch.mainWindow, repoId, gitStatusWorktreePaths)
    }
    if (
      supportsWorktreeHeadIdentityRefresh(watch) &&
      (pendingStructure.length > 0 || hasHeadIdentity)
    ) {
      void refreshWorktreeHeadIdentities(
        watch,
        watch.headIdentityRefresh,
        emitHeadIdentities,
        headIdentityScope
      )
    }
  }, WATCH_DEBOUNCE_MS)
}
