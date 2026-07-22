import { useCallback, useEffect, useRef, useState } from 'react'
import { View, StyleSheet, PanResponder } from 'react-native'
import { Stack, useGlobalSearchParams, usePathname } from 'expo-router'
import { colors } from '../../src/theme/mobile-theme'
import { useResponsiveLayout } from '../../src/layout/responsive-layout'
import {
  HOST_SIDEBAR_DEFAULT_WIDTH,
  HOST_SIDEBAR_MAX_WIDTH,
  HOST_SIDEBAR_MIN_WIDTH,
  loadHostSidebarWidth,
  saveHostSidebarWidth
} from '../../src/storage/preferences'
import { HostProtocolGate } from '../../src/components/HostProtocolGate'
import { HostScreen } from './[hostId]/index'

// Keep at least this much room for the detail pane when resizing the sidebar.
const MIN_DETAIL_WIDTH = 320
const RESIZE_EDGE_WIDTH = 24

// Clamp a sidebar width to the bounds and to the current window, so a width
// saved on a larger device can't starve the detail pane on a narrower one.
function clampSidebarToWindow(width: number, windowWidth: number): number {
  const hardMax = Math.max(
    HOST_SIDEBAR_MIN_WIDTH,
    Math.min(HOST_SIDEBAR_MAX_WIDTH, windowWidth - MIN_DETAIL_WIDTH)
  )
  return Math.min(hardMax, Math.max(HOST_SIDEBAR_MIN_WIDTH, Math.round(width)))
}

function HostStack({ animation }: { animation: 'none' | 'default' }) {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bgBase },
        // In the tablet split view the detail pane should swap instantly like
        // a desktop master-detail; the default slide animates the outgoing
        // screen and briefly reveals the one beneath it. Phones keep the slide.
        animation
      }}
    >
      <Stack.Screen name="[hostId]/index" options={{ title: 'Host' }} />
      <Stack.Screen name="[hostId]/edit" options={{ title: 'Edit host' }} />
      <Stack.Screen name="[hostId]/accounts" options={{ title: 'Accounts' }} />
      <Stack.Screen name="[hostId]/tasks" options={{ title: 'Tasks' }} />
      <Stack.Screen name="[hostId]/session/[worktreeId]" options={{ title: 'Terminal' }} />
      <Stack.Screen
        name="[hostId]/source-control/[worktreeId]"
        options={{ title: 'Source Control' }}
      />
      <Stack.Screen
        name="[hostId]/agent-history/[worktreeId]"
        options={{ title: 'Agent Session History' }}
      />
      <Stack.Screen name="[hostId]/review/[worktreeId]" options={{ title: 'Changes' }} />
      <Stack.Screen name="[hostId]/pr/[worktreeId]" options={{ title: 'Pull Request' }} />
    </Stack>
  )
}

export default function HostGroupLayout() {
  // Wide layout = tablet/foldable canvas (see responsive-layout-metrics).
  const { isWideLayout, width: windowWidth } = useResponsiveLayout()
  const { hostId, action } = useGlobalSearchParams<{ hostId?: string; action?: string }>()
  const pathname = usePathname()
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(HOST_SIDEBAR_DEFAULT_WIDTH)

  // Refs keep the once-created PanResponder reading live values without
  // re-creating its handlers on every width/window change.
  const widthRef = useRef(sidebarWidth)
  widthRef.current = sidebarWidth
  const windowWidthRef = useRef(windowWidth)
  windowWidthRef.current = windowWidth
  const dragStartRef = useRef(sidebarWidth)

  // Restore the user's last sidebar width, clamped to the current window.
  useEffect(() => {
    let stale = false
    void loadHostSidebarWidth().then((saved) => {
      if (!stale) {
        setSidebarWidth(clampSidebarToWindow(saved, windowWidthRef.current))
      }
    })
    return () => {
      stale = true
    }
  }, [])

  // Re-clamp when the window shrinks (fold, rotation, split-screen) so the
  // detail pane keeps at least MIN_DETAIL_WIDTH.
  useEffect(() => {
    setSidebarWidth((current) => clampSidebarToWindow(current, windowWidth))
  }, [windowWidth])

  const hideSidebar = useCallback(() => setSidebarOpen(false), [])
  const showSidebar = isWideLayout && !!hostId
  const detailHasContent = !!hostId && pathname !== `/h/${hostId}`
  const canCollapseSidebar = showSidebar && detailHasContent

  // Why: there is no reveal button — navigating Back to the base host route brings
  // the sidebar back (and that route's detail pane is only a placeholder, so a
  // hidden sidebar would leave nothing useful).
  useEffect(() => {
    if (showSidebar && !detailHasContent) {
      setSidebarOpen(true)
    }
  }, [detailHasContent, showSidebar])

  // Why: the resizer lives on a dedicated edge handle (a leaf overlay at the
  // sidebar's right border), NOT on the sidebar container. On Android a child
  // ScrollView/FlatList claims the native touch responder, so a parent-View
  // PanResponder never sees the move events and the drag silently no-ops; a
  // dedicated handle on top of the content captures the gesture on both
  // platforms. It claims on start (capture too) since nothing sits under it.
  const resizer = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        dragStartRef.current = widthRef.current
      },
      onPanResponderMove: (_evt, g) => {
        setSidebarWidth(clampSidebarToWindow(dragStartRef.current + g.dx, windowWidthRef.current))
      },
      onPanResponderRelease: () => {
        void saveHostSidebarWidth(widthRef.current)
      },
      onPanResponderTerminate: () => {
        void saveHostSidebarWidth(widthRef.current)
      }
    })
  ).current

  // The detail Stack stays at a stable position in the tree across width
  // changes so a fold/rotation doesn't remount the navigator and reset the
  // navigation stack — only the sidebar pane toggles in and out.
  return (
    <HostProtocolGate hostId={hostId}>
      <View style={styles.row}>
        {showSidebar && sidebarOpen ? (
          <View style={[styles.sidebar, { width: sidebarWidth }]}>
            <HostScreen
              embedded
              hostId={hostId}
              action={action}
              onHideSidebar={canCollapseSidebar ? hideSidebar : undefined}
            />
            {/* Dedicated drag handle straddling the right border — see resizer note. */}
            <View style={styles.resizeHandle} {...resizer.panHandlers} />
          </View>
        ) : null}
        <View style={styles.detail}>
          <HostStack animation={showSidebar ? 'none' : 'default'} />
        </View>
      </View>
    </HostProtocolGate>
  )
}

const styles = StyleSheet.create({
  row: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: colors.bgBase
  },
  sidebar: {
    borderRightWidth: 1,
    borderRightColor: colors.borderSubtle
  },
  // Invisible grab strip over the sidebar's right edge. Absolute + elevated so it
  // sits above the worktree list and reliably owns the drag on Android.
  resizeHandle: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    width: RESIZE_EDGE_WIDTH,
    zIndex: 20,
    elevation: 20
  },
  detail: {
    flex: 1,
    minWidth: 0
  }
})
