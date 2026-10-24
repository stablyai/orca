import {
  formatActiveFilterBadge,
  formatActiveFilterLabel
} from '../../../src/shared/workspace-view/workspace-row-filters'

/** The desktop's name for the control that opens these options, and for the options themselves. */
export const WORKSPACE_OPTIONS_TITLE = 'Workspace options'

/** The chip's corner badge, capped as on the desktop; null with no active filter. */
export function workspaceOptionsBadgeText(activeFilterCount: number): string | null {
  return activeFilterCount > 0 ? formatActiveFilterBadge(activeFilterCount) : null
}

/** The desktop trigger's accessibility label, word for word. */
export function workspaceOptionsAccessibilityLabel(activeFilterCount: number): string {
  return activeFilterCount > 0
    ? `${WORKSPACE_OPTIONS_TITLE} (${formatActiveFilterLabel(activeFilterCount)} active)`
    : WORKSPACE_OPTIONS_TITLE
}

// Why: the host may be headless, so the note can't promise a desktop sidebar.
export const WORKSPACE_VIEW_SHARED_NOTE = 'Synced across your devices'
