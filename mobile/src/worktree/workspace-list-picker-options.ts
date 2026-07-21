import type { PickerOption } from '../components/PickerModal'
import type { MobileGroupMode, MobileSortMode } from './workspace-view-settings'

export const WORKSPACE_SORT_OPTIONS: PickerOption<MobileSortMode>[] = [
  // Why: desktop and persisted state keep the `smart` key, while mobile shows the product label.
  {
    value: 'smart',
    label: 'Agent activity',
    subtitle: 'Agents that need attention, then recent activity'
  },
  { value: 'name', label: 'Name', subtitle: 'Alphabetical by name' },
  { value: 'recent', label: 'Recent', subtitle: 'Most recent output first' },
  { value: 'repo', label: 'Repo', subtitle: 'Repository, then workspace name' },
  { value: 'manual', label: 'Manual', subtitle: 'Server order' }
]

export const WORKSPACE_GROUP_OPTIONS: PickerOption<MobileGroupMode>[] = [
  { value: 'none', label: 'No Grouping' },
  { value: 'workspaceStatus', label: 'Status' },
  { value: 'repo', label: 'Repository' },
  { value: 'prStatus', label: 'PR Status' },
  { value: 'projectGroup', label: 'Project Group' }
]

// Compact label for the group-mode chip in the list toolbar (distinct from the
// fuller picker labels above).
const GROUP_TOOLBAR_LABELS: Record<MobileGroupMode, string> = {
  none: 'Group',
  workspaceStatus: 'Status',
  repo: 'Repo',
  prStatus: 'PR',
  projectGroup: 'Groups'
}

export function groupModeToolbarLabel(mode: MobileGroupMode): string {
  return GROUP_TOOLBAR_LABELS[mode]
}
