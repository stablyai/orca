import type { WorkspaceDisplayInfo } from '../../shared/floating-workspace-display'

export type FloatingWorkspaceApi = {
  getDisplays: () => Promise<WorkspaceDisplayInfo[]>
  getCurrentDisplayId: () => Promise<number | null>
  moveToDisplay: (displayId: number) => Promise<boolean>
  moveToNextDisplay: () => Promise<boolean>
  identifyDisplays: () => Promise<boolean>
  onDisplaysChanged: (callback: (displays: WorkspaceDisplayInfo[]) => void) => () => void
  minimize: () => Promise<boolean>
  isMinimized: () => Promise<boolean>
}
