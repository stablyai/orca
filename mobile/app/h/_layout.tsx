import { useCallback, useEffect, useRef, useState } from 'react'
import { View, PanResponder, Platform } from 'react-native'
import { useGlobalSearchParams, usePathname } from 'expo-router'
import { colors } from '../../src/theme/mobile-theme'
import { themedStyleSheet } from '../../src/theme/themed-styles'
import { useMobileColorScheme } from '../../src/theme/use-mobile-color-scheme'
import { useResponsiveLayout } from '../../src/layout/responsive-layout'
import { useFoldSplit } from '../../src/layout/use-fold-split'
import {
  HOST_SIDEBAR_DEFAULT_WIDTH,
  HOST_SIDEBAR_MAX_WIDTH,
  HOST_SIDEBAR_MIN_WIDTH,
  loadHostSidebarWidth,
  saveHostSidebarWidth
} from '../../src/storage/preferences'
import { HostProtocolGate } from '../../src/components/HostProtocolGate'
import { HostScreen } from '../../src/host-screen/HostScreen'
import { HostStack } from '../../src/navigation/host-stack'
import { HostSidebarRevealContext } from '../../src/layout/host-sidebar-reveal'
import { HostAreaServingContext } from '../../src/mobile-web-shell/host-area-serving'
import { usePageOwnsHostArea } from '../../src/mobile-web-shell/page-owns-host-area'
import { isOverlayPageRoute } from '../../src/new-workspace/overlay-page-route'

// Keep at least this much room for the detail pane when resizing the sidebar.
const MIN_DETAIL_WIDTH = 320
const RESIZE_EDGE_WIDTH = 24

// Clamp restored sidebar width to current window so a smaller device retains usable detail space.
function clampSidebarToWindow(width: number, windowWidth: number): number {
  const hardMax = Math.max(
    HOST_SIDEBAR_MIN_WIDTH,
    Math.min(HOST_SIDEBAR_MAX_WIDTH, windowWidth - MIN_DETAIL_WIDTH)
  )
  return Math.min(hardMax, Math.max(HOST_SIDEBAR_MIN_WIDTH, Math.round(width)))
}

export default function HostGroupLayout() {
  useMobileColorScheme()
  // Wide layout = tablet/foldable canvas (see responsive-layout-metrics).
  const { isWideLayout, width: windowWidth } = useResponsiveLayout()
  const { hostId } = useGlobalSearchParams<{ hostId?: string }>()
  const pathname = usePathname()
  const overlayRoute = isOverlayPageRoute(pathname)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  // Keep the chosen width and clamp it per window, so a narrow pose (fold, rotation) never shrinks it for good.
  const [chosenSidebarWidth, setSidebarWidth] = useState(HOST_SIDEBAR_DEFAULT_WIDTH)
  const sidebarWidth = clampSidebarToWindow(chosenSidebarWidth, windowWidth)

  // Refs keep once-created PanResponder handlers reading current widths.
  const widthRef = useRef(sidebarWidth)
  widthRef.current = sidebarWidth
  const windowWidthRef = useRef(windowWidth)
  windowWidthRef.current = windowWidth
  const dragStartRef = useRef(sidebarWidth)

  useEffect(() => {
    let stale = false
    void loadHostSidebarWidth().then((saved) => {
      if (!stale) {
        setSidebarWidth(saved)
      }
    })
    return () => {
      stale = true
    }
  }, [])

  const hideSidebar = useCallback(() => setSidebarOpen(false), [])
  const revealSidebar = useCallback(() => setSidebarOpen(true), [])
  const [hostAreaServing, setHostAreaServing] = useState(false)
  const pageOwnsHostArea = usePageOwnsHostArea()
  // One owner: the page only with its init fact; natively all but a host route its page is serving.
  const sidebarDrawnHere =
    Platform.OS === 'web' ? pageOwnsHostArea : !(pathname === `/h/${hostId}` && hostAreaServing)
  const showSidebar = isWideLayout && !!hostId && sidebarDrawnHere
  const detailHasContent = !!hostId && pathname !== `/h/${hostId}`
  // Book posture: the sidebar takes the half before the fold and the detail the half after it, so
  // the terminal never runs across the crease.
  const foldSplit = useFoldSplit()
  const foldSidebarWidth =
    showSidebar &&
    foldSplit?.axis === 'vertical' &&
    foldSplit.start >= HOST_SIDEBAR_MIN_WIDTH &&
    foldSplit.size - foldSplit.end >= MIN_DETAIL_WIDTH
      ? foldSplit.start
      : null
  const foldGap = foldSidebarWidth === null || !foldSplit ? 0 : foldSplit.end - foldSplit.start
  const canCollapseSidebar = showSidebar && detailHasContent && foldSidebarWidth === null

  // Base host detail is a placeholder; hiding its sidebar would leave nothing useful.
  useEffect(() => {
    if (showSidebar && !detailHasContent) {
      setSidebarOpen(true)
    }
  }, [detailHasContent, showSidebar])

  // Use an overlaid leaf drag handle: Android ScrollView/FlatList captures touches before a parent PanResponder.
  // Claim start/capture because nothing lies beneath the handle; keep it off the sidebar container.
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

  // Keep detail Stack at a stable tree position so fold/rotation cannot remount navigation.
  return (
    <HostProtocolGate hostId={hostId} transparentWhilePending={overlayRoute}>
      <View style={[styles.row, overlayRoute && styles.transparent]}>
        {showSidebar && (sidebarOpen || foldSidebarWidth !== null) ? (
          <View style={[styles.sidebar, { width: foldSidebarWidth ?? sidebarWidth }]}>
            <HostScreen
              embedded
              hostId={hostId}
              onHideSidebar={canCollapseSidebar ? hideSidebar : undefined}
            />
            {/* Edge drag handle captures Android gestures above the list. */}
            {foldSidebarWidth === null ? (
              <View style={styles.resizeHandle} {...resizer.panHandlers} />
            ) : null}
          </View>
        ) : null}
        {foldGap > 0 ? <View style={{ width: foldGap }} /> : null}
        <View style={styles.detail}>
          <HostAreaServingContext.Provider value={setHostAreaServing}>
            <HostSidebarRevealContext.Provider
              value={
                showSidebar && !sidebarOpen && foldSidebarWidth === null ? revealSidebar : null
              }
            >
              <HostStack animation={showSidebar ? 'none' : 'default'} />
            </HostSidebarRevealContext.Provider>
          </HostAreaServingContext.Provider>
        </View>
      </View>
    </HostProtocolGate>
  )
}

const styles = themedStyleSheet(() => ({
  row: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: colors.bgBase
  },
  transparent: {
    backgroundColor: 'transparent'
  },
  sidebar: {
    borderRightWidth: 1,
    borderRightColor: colors.borderSubtle
  },
  // Elevated edge strip must sit above list to own Android drags.
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
}))
