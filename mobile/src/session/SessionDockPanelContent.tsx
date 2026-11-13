import { memo } from 'react'
import { MobileSourceControlRoutePanel } from '../source-control/MobileSourceControlRoutePanel'
import { MobileFileExplorerPanel } from '../files/explorer/MobileFileExplorerPanel'
import type { ActivePanel } from './session-panel-host'

export type SessionDockPanelContentProps = {
  activePanel: Exclude<ActivePanel, null>
  hostId: string
  worktreeId: string
  name: string
  onRequestClose: () => void
}

// Width-independent panel props let memo skip content rerenders during resize.
export const SessionDockPanelContent = memo(function SessionDockPanelContent({
  activePanel,
  hostId,
  worktreeId,
  name,
  onRequestClose
}: SessionDockPanelContentProps) {
  // Reuse the source-control hub so dock icon switches retain commit draft, visited tabs and scroll.
  if (activePanel === 'sourceControl' || activePanel === 'pr') {
    return (
      <MobileSourceControlRoutePanel
        hostId={hostId}
        worktreeId={worktreeId}
        name={name}
        embedded
        initialTab={activePanel === 'pr' ? 'pr' : 'changes'}
        onRequestClose={onRequestClose}
      />
    )
  }
  return (
    <MobileFileExplorerPanel
      hostId={hostId}
      worktreeId={worktreeId}
      name={name}
      embedded
      onRequestClose={onRequestClose}
    />
  )
})
