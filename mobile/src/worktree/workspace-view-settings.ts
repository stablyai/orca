// Bi-directional mapping between the mobile workspaces screen's local view model
// and the desktop's shared PersistedUIState (read/written via the ui.get/ui.set
// RPCs). Keeping these settings in the same global store is what lets a grouping
// or filter change on the phone show up on desktop and vice-versa.

export type MobileGroupMode = 'none' | 'workspaceStatus' | 'repo' | 'prStatus'
// Desktop sort adds 'manual'; mobile renders it but sorts by server order.
export type MobileSortMode = 'smart' | 'name' | 'recent' | 'repo' | 'manual'

// Desktop PersistedUIState fields this screen syncs (a structural subset).
export type WorkspaceViewSettings = {
  groupBy?: 'none' | 'workspace-status' | 'repo' | 'pr-status'
  sortBy?: 'name' | 'smart' | 'recent' | 'repo' | 'manual'
  hideSleepingWorkspaces?: boolean
  hideDefaultBranchWorkspace?: boolean
  filterRepoIds?: string[]
  collapsedGroups?: string[]
  workspaceHostScope?: string
  visibleWorkspaceHostIds?: string[] | null
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

export type MobileViewState = {
  groupMode: MobileGroupMode
  sortMode: MobileSortMode
  hideSleeping: boolean
  hideDefaultBranch: boolean
  filterRepoIds: string[]
  collapsedGroups: string[]
  workspaceHostScope?: string
  visibleWorkspaceHostIds?: string[] | null
}

// Apply a desktop PersistedUIState onto the local view state, leaving any field
// the desktop hasn't set untouched (so a partial ui.get doesn't clobber).
export function applyDesktopViewSettings(
  current: MobileViewState,
  settings: WorkspaceViewSettings
): MobileViewState {
  const groupMode = groupModeFromDesktop(settings.groupBy)
  const sortMode = sortModeFromDesktop(settings.sortBy)
  const next: MobileViewState = {
    groupMode: groupMode ?? current.groupMode,
    sortMode: sortMode ?? current.sortMode,
    hideSleeping: settings.hideSleepingWorkspaces ?? current.hideSleeping,
    hideDefaultBranch: settings.hideDefaultBranchWorkspace ?? current.hideDefaultBranch,
    filterRepoIds: settings.filterRepoIds ?? current.filterRepoIds,
    collapsedGroups: settings.collapsedGroups ?? current.collapsedGroups
  }
  if (settings.workspaceHostScope !== undefined) {
    next.workspaceHostScope = settings.workspaceHostScope
  } else if (current.workspaceHostScope !== undefined) {
    next.workspaceHostScope = current.workspaceHostScope
  }
  if (settings.visibleWorkspaceHostIds !== undefined) {
    next.visibleWorkspaceHostIds = settings.visibleWorkspaceHostIds
  } else if (current.visibleWorkspaceHostIds !== undefined) {
    next.visibleWorkspaceHostIds = current.visibleWorkspaceHostIds
  }
  return next
}
