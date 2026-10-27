import {
  formatActiveFilterBadge,
  formatActiveFilterLabel
} from '../../../src/shared/workspace-view/workspace-row-filters'

export const WORKSPACE_OPTIONS_TITLE = 'Workspace options'

export function workspaceOptionsBadgeText(activeFilterCount: number): string | null {
  return activeFilterCount > 0 ? formatActiveFilterBadge(activeFilterCount) : null
}

export function workspaceOptionsAccessibilityLabel(activeFilterCount: number): string {
  return activeFilterCount > 0
    ? `${WORKSPACE_OPTIONS_TITLE} (${formatActiveFilterLabel(activeFilterCount)} active)`
    : WORKSPACE_OPTIONS_TITLE
}

// Why: the host may be headless, so the note can't promise a desktop sidebar.
export const WORKSPACE_VIEW_SHARED_NOTE = 'Synced across your devices'
