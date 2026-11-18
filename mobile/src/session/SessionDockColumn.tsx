import { lazy, Suspense } from 'react'
import { View, StyleSheet } from 'react-native'
import { mobilePrSidebarStyles } from '../source-control/review/pull-request/mobile-pr-sidebar-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileDockResize } from './use-mobile-dock-resize'
import type { SessionDockPanelContentProps } from './SessionDockPanelContent'

type Props = SessionDockPanelContentProps & { availableWidth: number }

// Panels load with the first dock open so phone sessions, which never dock, skip Source Control and Files code.
const SessionDockPanelContent = lazy(() =>
  import('./SessionDockPanelContent').then((module) => ({
    default: module.SessionDockPanelContent
  }))
)

// Keep drag width state in this subtree; terminal refits follow frame onLayout and need no width prop.
export function SessionDockColumn({
  activePanel,
  hostId,
  worktreeId,
  name,
  availableWidth,
  onRequestClose
}: Props) {
  useMobileColorScheme()
  const { dockWidth, panHandlers } = useMobileDockResize(availableWidth)
  return (
    <View style={[mobilePrSidebarStyles.dockColumn, { width: dockWidth }]}>
      {/* Dedicated drag handle over the dock's left border — a leaf overlay so the
          inner ScrollView can't intercept the gesture on Android. */}
      <View style={styles.resizeHandle} {...panHandlers} />
      {/* The column frame paints at once; its panel fills in from local disk with no spinner. */}
      <Suspense fallback={null}>
        <SessionDockPanelContent
          activePanel={activePanel}
          hostId={hostId}
          worktreeId={worktreeId}
          name={name}
          onRequestClose={onRequestClose}
        />
      </Suspense>
    </View>
  )
}

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
