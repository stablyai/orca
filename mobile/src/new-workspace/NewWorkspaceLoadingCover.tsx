import { useEffect, useState } from 'react'
import { ActivityIndicator, Animated, Easing, Pressable, StyleSheet, View } from 'react-native'
import { bottomDrawerStyles } from '../components/bottom-drawer/bottom-drawer-styles'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { NewWorkspaceLoadProgress } from './new-workspace-load-progress'
import type { ShellOverlayDownload } from '../mobile-web-shell/presentation/shell-overlay-load'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

const EXIT_FADE_MS = 220

export function NewWorkspaceLoadingCover({
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
  const { modalMaxWidth } = useResponsiveLayout()
  const [presence] = useState(() => new Animated.Value(1))
  useEffect(() => {
    if (visible) {
      presence.setValue(1)
      return
    }
    const animation = Animated.timing(presence, {
      toValue: 0,
      duration: EXIT_FADE_MS,
      easing: Easing.in(Easing.quad),
      useNativeDriver: true
    })
    animation.start()
    return () => animation.stop()
  }, [presence, visible])
  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, { opacity: presence }]}
      pointerEvents={visible ? 'auto' : 'none'}
      testID="new-workspace-loading-cover"
    >
      <Pressable
        style={bottomDrawerStyles.backdrop}
        onPress={onCancel}
        accessibilityLabel={t('common.cancel', 'Cancel')}
      />
      <View style={styles.center} pointerEvents="none">
        <View style={[styles.body, { width: '100%', maxWidth: modalMaxWidth }]}>
          {download === null ? (
            <ActivityIndicator
              color={colors.onAccent}
              accessibilityLabel={t('newWorkspace.loadingDrawer.loading', 'Loading')}
            />
          ) : (
            <NewWorkspaceLoadProgress download={download} onBackdrop />
          )}
        </View>
      </View>
    </Animated.View>
  )
}

const styles = themedStyleSheet(() => ({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg
  }
}))
