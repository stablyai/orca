import { memo } from 'react'
import { View, StyleSheet } from 'react-native'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { MobileSourceControlPanel } from '../source-control/MobileSourceControlPanel'
import { MobileFileExplorerPanel } from '../files/MobileFileExplorerPanel'
import { MobilePrViewPanel } from '../components/pr-sidebar/MobilePrViewPanel'
import { mobilePrSidebarStyles } from '../components/pr-sidebar/mobile-pr-sidebar-styles'
import { useMobileDockResize } from './use-mobile-dock-resize'
import type { ActivePanel } from './session-panel-host'

type Props = {
  activePanel: Exclude<ActivePanel, null>
  hostId: string
  worktreeId: string
  name: string
  client: RpcClient | null
  connState: ConnectionState
  branch: string | null
  headSha: string | null
  isGithubRepo: boolean
  branchContextLoaded: boolean
  availableWidth: number
  onRequestClose: () => void
}

type DockPanelContentProps = Omit<Props, 'availableWidth'>

// The wide-layout right-hand dock beside the session content (KTD2/KTD6). Owns its own
// drag-resize state so dragging only re-renders this subtree (not the whole session
// screen), and the panel content is memoized so a width change doesn't re-render the
// embedded panel/comment list — only the container reflows. The terminal re-fit is
// driven separately off the terminal frame's onLayout, so it doesn't need the width.
export function SessionDockColumn({
  activePanel,
  hostId,
  worktreeId,
  name,
  client,
  connState,
  branch,
  headSha,
  isGithubRepo,
  branchContextLoaded,
  availableWidth,
  onRequestClose
}: Props) {
  const { dockWidth, panHandlers } = useMobileDockResize(availableWidth)
  return (
    <View style={[mobilePrSidebarStyles.dockColumn, { width: dockWidth }]}>
      {/* Dedicated drag handle over the dock's left border — a leaf overlay so the
          inner ScrollView can't intercept the gesture on Android. */}
      <View style={styles.resizeHandle} {...panHandlers} />
      <DockPanelContent
        activePanel={activePanel}
        hostId={hostId}
        worktreeId={worktreeId}
        name={name}
        client={client}
        connState={connState}
        branch={branch}
        headSha={headSha}
        isGithubRepo={isGithubRepo}
        branchContextLoaded={branchContextLoaded}
        onRequestClose={onRequestClose}
      />
    </View>
  )
}

// Memoized so a resize (width-only change on the parent) does not re-render the
// embedded panel — its props are width-independent, so React skips it during a drag.
const DockPanelContent = memo(function DockPanelContent({
  activePanel,
  hostId,
  worktreeId,
  name,
  client,
  connState,
  branch,
  headSha,
  isGithubRepo,
  branchContextLoaded,
  onRequestClose
}: DockPanelContentProps) {
  if (activePanel === 'sourceControl') {
    return (
      <MobileSourceControlPanel
        hostId={hostId}
        worktreeId={worktreeId}
        name={name}
        origin="session"
        embedded
        onRequestClose={onRequestClose}
      />
    )
  }
  if (activePanel === 'files') {
    return (
      <MobileFileExplorerPanel
        hostId={hostId}
        worktreeId={worktreeId}
        name={name}
        embedded
        onRequestClose={onRequestClose}
      />
    )
  }
  return (
    <MobilePrViewPanel
      client={client}
      connState={connState}
      worktreeId={worktreeId}
      branch={branch}
      headSha={headSha}
      isGithubRepo={isGithubRepo}
      branchContextLoaded={branchContextLoaded}
      embedded
      onRequestClose={onRequestClose}
    />
  )
})

const RESIZE_EDGE_WIDTH = 24

const styles = StyleSheet.create({
  // Invisible grab strip over the dock's left edge. Absolute + elevated so it sits
  // above the panel content and reliably owns the drag on Android.
  resizeHandle: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: RESIZE_EDGE_WIDTH,
    zIndex: 20,
    elevation: 20
  }
})
