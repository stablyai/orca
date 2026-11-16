import type { BrowserWindow } from 'electron'
import { basename } from 'node:path'
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
import {
  allCachedWorktreePaths,
  cachedWorktreePathsForScope
} from './worktree-head-identity-cached-paths'
import { invalidateGitStatusReads } from '../../../git/source-control/git-read-cache-invalidation'
import { notifyWorktreeGitStatusMetadataChanged } from '../../worktree-remote'
import {
  notifyGitStatusChangedForRemoteClients,
  notifyWatchedWorktreeCatalogChanged
} from '../../watched-worktree-catalog-notification'

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

// Structural and unattributed bursts may touch any checkout of this common dir, but no other repo's.
function changedWorktreePaths(
  watch: WorktreeBaseNotificationWatch,
  structural: boolean,
  attributed: string[] | null
): string[] | null {
  if (!structural && attributed) {
    return attributed
  }
  if (!supportsWorktreeHeadIdentityRefresh(watch)) {
    return null
  }
  // Like the head reader: only a `.git` common dir has a primary checkout.
  return allCachedWorktreePaths(watch.headIdentityRefresh.cache, basename(watch.path) === '.git')
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
    const changedPaths = changedWorktreePaths(
      watch,
      pendingStructure.length > 0,
      gitStatusWorktreePaths
    )
    clearPendingWorktreeBaseNotifications(watch)
    if (pendingStructure.length > 0 || sourceControlRepoIds.size > 0) {
      // Staging can keep a file's status letters, and a phone's re-read must not join a read begun before the change.
      invalidateGitStatusReads(changedPaths)
    }
    for (const repoId of pendingStructure) {
      notifyWatchedWorktreeCatalogChanged(watch.mainWindow, repoId)
      // The renderer re-reads status on worktrees:changed; phones' Changes doesn't, and HEAD or packed-refs moves arrive only here.
      notifyGitStatusChangedForRemoteClients(repoId, null)
    }
    for (const repoId of sourceControlRepoIds) {
      notifyWorktreeGitStatusMetadataChanged(watch.mainWindow, repoId, gitStatusWorktreePaths)
      notifyGitStatusChangedForRemoteClients(repoId, gitStatusWorktreePaths)
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
