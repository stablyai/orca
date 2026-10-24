import { useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Animated,
  Easing,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions
} from 'react-native'
import { BOTTOM_DRAWER_SHOW_DURATION_MS } from '../components/bottom-drawer-constants'
import { bottomDrawerStyles } from '../components/bottom-drawer-styles'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { useWindowSafeAreaInsets } from '../layout/side-safe-area'
import {
  DownloadProgressBar,
  downloadedMegabytesCaption
} from '../mobile-web-shell/DownloadProgressBar'
import type { ShellOverlayDownload } from '../mobile-web-shell/shell-overlay-load'
import { SHELL_PAGE_COVER_FADE_MS } from '../mobile-web-shell/ShellWaitingFrame'
import { colors, spacing, typography } from '../theme/mobile-theme'

const CANCEL_DRAG_DISTANCE = 40

/**
 * A short drawer while the page's Create Workspace drawer loads: a spinner, or the download while
 * there is one. It opens and dims as the shared drawer does, but in the screen's own window: a
 * native Modal over the loading WebView stalls the page behind it. It fades once the page has
 * painted with its own drawer up. A tap on the backdrop, a drag down or Back cancels.
 */
export function NewWorkspaceLoadingDrawer({
  visible,
  download,
  onCancel
}: {
  visible: boolean
  download: ShellOverlayDownload | null
  onCancel: () => void
}) {
  const insets = useWindowSafeAreaInsets()
  const { isWideLayout, modalMaxWidth } = useResponsiveLayout()
  const { height: screenHeight } = useWindowDimensions()
  const [progress] = useState(() => new Animated.Value(0))
  const [presence] = useState(() => new Animated.Value(1))
  const dragToCancel = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dy > CANCEL_DRAG_DISTANCE) {
            onCancel()
          }
        }
      }),
    [onCancel]
  )
  useEffect(() => {
    // Leaving, it fades as the shell's page cover does, eased in: the page's drawer is already up
    // beneath, and the WebView takes a frame or two after being shown to put it on screen.
    const animation = visible
      ? Animated.timing(progress, {
          toValue: 1,
          duration: BOTTOM_DRAWER_SHOW_DURATION_MS,
          useNativeDriver: true
        })
      : Animated.timing(presence, {
          toValue: 0,
          duration: SHELL_PAGE_COVER_FADE_MS,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true
        })
    if (visible) {
      presence.setValue(1)
    }
    animation.start()
    return () => animation.stop()
  }, [presence, progress, visible])
  const slide = progress.interpolate({ inputRange: [0, 1], outputRange: [screenHeight, 0] })
  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, { opacity: presence }]}
      pointerEvents={visible ? 'auto' : 'none'}
      testID="new-workspace-loading-drawer"
    >
      <Animated.View style={[bottomDrawerStyles.backdrop, { opacity: progress }]}>
        <Pressable
          style={bottomDrawerStyles.backdropPressable}
          onPress={onCancel}
          accessibilityLabel="Cancel"
        />
      </Animated.View>
      <View
        style={[
          bottomDrawerStyles.anchor,
          isWideLayout && bottomDrawerStyles.anchorWide,
          { paddingLeft: insets.left, paddingRight: insets.right }
        ]}
        pointerEvents="box-none"
      >
        <Animated.View
          style={[
            bottomDrawerStyles.drawer,
            {
              width: '100%',
              maxWidth: isWideLayout ? modalMaxWidth : undefined,
              paddingBottom: insets.bottom + spacing.lg,
              transform: [{ translateY: slide }]
            }
          ]}
          {...dragToCancel.panHandlers}
        >
          <View style={bottomDrawerStyles.handleHitArea}>
            <View style={bottomDrawerStyles.handle} />
          </View>
          <View style={styles.body}>
            {download === null ? (
              <ActivityIndicator color={colors.textSecondary} accessibilityLabel="Loading" />
            ) : (
              <DownloadProgress download={download} />
            )}
          </View>
        </Animated.View>
      </View>
    </Animated.View>
  )
}

function DownloadProgress({ download }: { download: ShellOverlayDownload }) {
  return (
    <>
      <DownloadProgressBar
        feed={download.feed}
        receivedBytes={download.receivedBytes}
        totalBytes={download.totalBytes}
        accessibilityLabel="Downloading"
      />
      <Text style={styles.caption}>
        Downloading… {downloadedMegabytesCaption(download.receivedBytes, download.totalBytes)}
      </Text>
    </>
  )
}

const styles = StyleSheet.create({
  body: {
    height: 96,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm
  },
  caption: {
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums']
  }
})
