import { View, StyleSheet, type GestureResponderHandlers } from 'react-native'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { MobileSourceControlPanel } from '../source-control/MobileSourceControlPanel'
import { MobileFileExplorerPanel } from '../files/MobileFileExplorerPanel'
import { MobilePrViewPanel } from '../components/pr-sidebar/MobilePrViewPanel'
import { mobilePrSidebarStyles } from '../components/pr-sidebar/mobile-pr-sidebar-styles'
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
  width: number
  // Spread onto the dedicated left-edge drag handle (see use-mobile-dock-resize).
  resizeHandlers: GestureResponderHandlers
  onRequestClose: () => void
}

// The wide-layout right-hand dock beside the session content (KTD2/KTD6). Extracted
// from the session screen to keep that file under its line budget; renders exactly one
// embedded panel keyed off activePanel.
export function SessionDockColumn({
  activePanel,
  hostId,
  worktreeId,
  name,
  client,
  connState,
  branch,
  headSha,
  width,
  resizeHandlers,
  onRequestClose
}: Props) {
  return (
    <View style={[mobilePrSidebarStyles.dockColumn, { width }]}>
      {/* Dedicated drag handle over the dock's left border — a leaf overlay so the
          inner ScrollView can't intercept the gesture on Android. */}
      <View style={styles.resizeHandle} {...resizeHandlers} />
      {activePanel === 'sourceControl' ? (
        <MobileSourceControlPanel
          hostId={hostId}
          worktreeId={worktreeId}
          name={name}
          origin="session"
          embedded
          onRequestClose={onRequestClose}
        />
      ) : activePanel === 'files' ? (
        <MobileFileExplorerPanel
          hostId={hostId}
          worktreeId={worktreeId}
          name={name}
          embedded
          onRequestClose={onRequestClose}
        />
      ) : (
        <MobilePrViewPanel
          client={client}
          connState={connState}
          worktreeId={worktreeId}
          branch={branch}
          headSha={headSha}
          embedded
          onRequestClose={onRequestClose}
        />
      )}
    </View>
  )
}

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
