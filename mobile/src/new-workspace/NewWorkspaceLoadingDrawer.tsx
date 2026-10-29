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
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { useWindowSafeAreaInsets } from '../layout/side-safe-area'
import {
  DownloadProgressBar,
  downloadedMegabytesCaption
} from '../mobile-web-shell/DownloadProgressBar'
import type { ShellOverlayDownload } from '../mobile-web-shell/shell-overlay-load'
import { SHELL_PAGE_COVER_FADE_MS } from '../mobile-web-shell/ShellWaitingFrame'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

const CANCEL_DRAG_DISTANCE = 40

// Render in the loading WebView’s window: a native Modal stalls the page behind it. Fade only after the page paints its own drawer; backdrop/drag/Back cancel.
export function NewWorkspaceLoadingDrawer({
  visible,
  download,
  onCancel
}: {
  visible: boolean
  download: ShellOverlayDownload | null
  onCancel: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
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
    // Ease the exit fade while the shown WebView takes its first frames with the page drawer underneath.
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
          accessibilityLabel={t('common.cancel', 'Cancel')}
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
              <ActivityIndicator
                color={colors.textSecondary}
                accessibilityLabel={t('newWorkspace.loadingDrawer.loading', 'Loading')}
              />
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
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <>
      <DownloadProgressBar
        feed={download.feed}
        receivedBytes={download.receivedBytes}
        totalBytes={download.totalBytes}
        accessibilityLabel={t('newWorkspace.loadingDrawer.downloading', 'Downloading')}
      />
      <Text style={styles.caption}>
        {t('newWorkspace.loadingDrawer.downloadProgress', 'Downloading… {{progress}}', {
          progress: downloadedMegabytesCaption(download.receivedBytes, download.totalBytes)
        })}
      </Text>
    </>
  )
}

const styles = themedStyleSheet(() => ({
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
}))
