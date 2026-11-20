import type { ActiveRightSidebarTab } from '../../../shared/ui-chrome/ui-chrome-types'

export type WorkspaceMode = 'work' | 'code'

type WorkspaceModeSettings = {
  workspaceMode?: WorkspaceMode
  toolsSidebarPosition?: 'left' | 'right'
}

/** Work is the default: older profiles without the preference keep it. */
export function resolveWorkspaceMode(
  settings: WorkspaceModeSettings | null | undefined
): WorkspaceMode {
  return settings?.workspaceMode === 'code' ? 'code' : 'work'
}

export type WorkspaceModeLayoutBundle = {
  toolsSidebarPosition: 'left' | 'right'
  /** Left session sidebar open. */
  sidebarOpen: boolean
  /** Tools sidebar open. */
  rightSidebarOpen: boolean
  rightSidebarTab: ActiveRightSidebarTab
}

/** Fixed panel arrangement each mode switch restores. */
export function workspaceModeLayoutBundle(mode: WorkspaceMode): WorkspaceModeLayoutBundle {
  // Why: Work pairs the session list with a center chat; Code pairs the file
  // tree with editor center and chat right. Both stay pinned, not dragged.
  return mode === 'code'
    ? {
        toolsSidebarPosition: 'left',
        sidebarOpen: false,
        rightSidebarOpen: true,
        rightSidebarTab: 'explorer'
      }
    : {
        toolsSidebarPosition: 'right',
        sidebarOpen: true,
        rightSidebarOpen: false,
        rightSidebarTab: 'explorer'
      }
}
