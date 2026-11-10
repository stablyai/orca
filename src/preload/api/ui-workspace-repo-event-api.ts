import type { WorkspaceRepoSelection } from '../../shared/window-shortcut-policy'

export type UiWorkspaceRepoEventApi = {
  onSelectWorkspaceRepo: (callback: (selection: WorkspaceRepoSelection) => void) => () => void
}
