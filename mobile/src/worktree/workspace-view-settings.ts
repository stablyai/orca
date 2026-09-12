// Bi-directional mapping between the mobile workspaces screen's local view model
// and the desktop's shared PersistedUIState (read/written via the ui.get/ui.set
// RPCs). Keeping these settings in the same global store is what lets a grouping
// or filter change on the phone show up on desktop and vice-versa.

import type { WorkspaceStatusDefinition } from '../../../src/shared/worktree/types'
import { coerceMobileWorkspaceStatuses } from './mobile-workspace-statuses'

export type MobileGroupMode = 'none' | 'workspaceStatus' | 'repo' | 'prStatus'
// Desktop sort adds 'manual'; mobile renders it but sorts by server order.
export type MobileSortMode = 'smart' | 'name' | 'recent' | 'repo' | 'manual'

// Desktop PersistedUIState fields this screen syncs (a structural subset).
export type WorkspaceViewSettings = {
  groupBy?: 'none' | 'workspace-status' | 'repo' | 'pr-status'
  sortBy?: 'name' | 'smart' | 'recent' | 'repo' | 'manual'
  hideSleepingWorkspaces?: boolean
  hideDefaultBranchWorkspace?: boolean
  alwaysShowDefaultBranchWorkspace?: boolean
  filterRepoIds?: string[]
  collapsedGroups?: string[]
  workspaceStatuses?: WorkspaceStatusDefinition[]
}

const GROUP_TO_DESKTOP: Record<MobileGroupMode, NonNullable<WorkspaceViewSettings['groupBy']>> = {
  none: 'none',
  workspaceStatus: 'workspace-status',
  repo: 'repo',
  prStatus: 'pr-status'
}

const GROUP_FROM_DESKTOP: Record<NonNullable<WorkspaceViewSettings['groupBy']>, MobileGroupMode> = {
  none: 'none',
  'workspace-status': 'workspaceStatus',
  repo: 'repo',
  'pr-status': 'prStatus'
}

const SORT_VALUES: readonly MobileSortMode[] = ['smart', 'name', 'recent', 'repo', 'manual']

export function groupModeToDesktop(
  mode: MobileGroupMode
): NonNullable<WorkspaceViewSettings['groupBy']> {
  return GROUP_TO_DESKTOP[mode]
}

export function groupModeFromDesktop(
  groupBy: WorkspaceViewSettings['groupBy']
): MobileGroupMode | null {
  return groupBy ? (GROUP_FROM_DESKTOP[groupBy] ?? null) : null
}

export function sortModeFromDesktop(
  sortBy: WorkspaceViewSettings['sortBy']
): MobileSortMode | null {
  return sortBy && SORT_VALUES.includes(sortBy) ? sortBy : null
}

/**
 * Map a user edit to the ui.set payload, carrying only the fields the edit touched.
 *
 * Why patch-only (STA-5781): the shared store is edited concurrently by desktop and
 * web clients, and this screen's mirror refreshes only on connect/focus. Echoing the
 * whole snapshot let a stale mirror revert sibling fields another client had just
 * changed; the host merges partial updates field-by-field, so sending only the
 * touched fields is lossless. This also supersedes the old #8873 special case:
 * alwaysShowDefaultBranchWorkspace has no mobile toggle, so it is simply never in a
 * patch and can no longer revert a desktop opt-out.
 */
export function buildWorkspaceViewSettingsUpdate(
  patch: Partial<MobileViewState>,
  next: MobileViewState
): WorkspaceViewSettings {
  const update: WorkspaceViewSettings = {}
  if ('groupMode' in patch) {
    update.groupBy = groupModeToDesktop(next.groupMode)
  }
  if ('sortMode' in patch) {
    update.sortBy = next.sortMode
  }
  if ('hideSleeping' in patch) {
    update.hideSleepingWorkspaces = next.hideSleeping
  }
  if ('hideDefaultBranch' in patch) {
    update.hideDefaultBranchWorkspace = next.hideDefaultBranch
  }
  if ('alwaysShowDefaultBranch' in patch) {
    update.alwaysShowDefaultBranchWorkspace = next.alwaysShowDefaultBranch
  }
  if ('filterRepoIds' in patch) {
    update.filterRepoIds = next.filterRepoIds
  }
  if ('collapsedGroups' in patch) {
    update.collapsedGroups = next.collapsedGroups
  }
  if ('workspaceStatuses' in patch) {
    update.workspaceStatuses = [...next.workspaceStatuses]
  }
  return update
}

export type MobileViewState = {
  groupMode: MobileGroupMode
  sortMode: MobileSortMode
  hideSleeping: boolean
  hideDefaultBranch: boolean
  alwaysShowDefaultBranch: boolean
  filterRepoIds: string[]
  collapsedGroups: string[]
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
}

// Apply a desktop PersistedUIState onto the local view state, leaving any field
// the desktop hasn't set untouched (so a partial ui.get doesn't clobber).
export function applyDesktopViewSettings(
  current: MobileViewState,
  settings: WorkspaceViewSettings
): MobileViewState {
  const groupMode = groupModeFromDesktop(settings.groupBy)
  const sortMode = sortModeFromDesktop(settings.sortBy)
  // Why: a partially hydrated desktop settings payload may carry an empty
  // status catalog; mobile must keep renderable groups instead of hiding rows.
  const workspaceStatuses = settings.workspaceStatuses
    ? coerceMobileWorkspaceStatuses(settings.workspaceStatuses)
    : current.workspaceStatuses
  const next: MobileViewState = {
    groupMode: groupMode ?? current.groupMode,
    sortMode: sortMode ?? current.sortMode,
    hideSleeping: settings.hideSleepingWorkspaces ?? current.hideSleeping,
    hideDefaultBranch: settings.hideDefaultBranchWorkspace ?? current.hideDefaultBranch,
    alwaysShowDefaultBranch:
      settings.alwaysShowDefaultBranchWorkspace ?? current.alwaysShowDefaultBranch,
    filterRepoIds: settings.filterRepoIds ?? current.filterRepoIds,
    collapsedGroups: settings.collapsedGroups ?? current.collapsedGroups,
    workspaceStatuses
  }
  return next
}
