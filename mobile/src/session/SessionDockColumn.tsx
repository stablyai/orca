import { memo } from 'react'
import { View, StyleSheet } from 'react-native'
import { MobileSourceControlPanel } from '../source-control/MobileSourceControlPanel'
import { MobileFileExplorerPanel } from '../files/MobileFileExplorerPanel'
import { mobilePrSidebarStyles } from '../components/pr-sidebar/mobile-pr-sidebar-styles'
import { useMobileDockResize } from './use-mobile-dock-resize'
import type { ActivePanel } from './session-panel-host'

type Props = {
  activePanel: Exclude<ActivePanel, null>
  hostId: string
  worktreeId: string
  name: string
  availableWidth: number
  onRequestClose: () => void
  onFileOpenStart?: () => void
  onOpenedFileDiff?: (relativePath: string) => void
}

type DockPanelContentProps = Omit<Props, 'availableWidth'>

// Keep drag width state in this subtree; terminal refits follow frame onLayout and need no width prop.
export function SessionDockColumn({
  activePanel,
  hostId,
  worktreeId,
  name,
  availableWidth,
  onRequestClose,
  onFileOpenStart,
  onOpenedFileDiff
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
        onRequestClose={onRequestClose}
        onFileOpenStart={onFileOpenStart}
        onOpenedFileDiff={onOpenedFileDiff}
      />
    </View>
  )
}

// Width-independent panel props let memo skip content rerenders during resize.
const DockPanelContent = memo(function DockPanelContent({
  activePanel,
  hostId,
  worktreeId,
  name,
  onRequestClose,
  onFileOpenStart,
  onOpenedFileDiff
}: DockPanelContentProps) {
  // Reuse the source-control hub so dock icon switches retain commit draft, visited tabs and scroll.
  if (activePanel === 'sourceControl' || activePanel === 'pr') {
    return (
      <MobileSourceControlPanel
        hostId={hostId}
        worktreeId={worktreeId}
        name={name}
        origin="session"
        embedded
        initialTab={activePanel === 'pr' ? 'pr' : 'changes'}
        onRequestClose={onRequestClose}
        onFileOpenStart={onFileOpenStart}
        onOpenedFileDiff={onOpenedFileDiff}
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

const RESIZE_EDGE_WIDTH = 24

const styles = StyleSheet.create({
  // Elevate the absolute grab strip so Android scroll content cannot steal its drag.
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
