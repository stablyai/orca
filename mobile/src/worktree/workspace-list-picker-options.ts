import type { PickerOption } from '../components/PickerModal'
import type { MobileGroupMode, MobileSortMode } from './workspace-view-settings'

export const WORKSPACE_SORT_OPTIONS: PickerOption<MobileSortMode>[] = [
  { value: 'smart', label: 'Smart', subtitle: 'Unread and active first' },
  { value: 'name', label: 'Name', subtitle: 'Alphabetical by name' },
  { value: 'recent', label: 'Recent', subtitle: 'Most recent output first' },
  { value: 'repo', label: 'Repo', subtitle: 'Repository, then workspace name' },
  { value: 'manual', label: 'Manual', subtitle: 'Server order' }
]

export const WORKSPACE_GROUP_OPTIONS: PickerOption<MobileGroupMode>[] = [
  { value: 'none', label: 'No Grouping' },
  { value: 'workspaceStatus', label: 'Status' },
  { value: 'repo', label: 'Repository' },
  { value: 'prStatus', label: 'PR Status' }
]
