import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, Animated, Easing, StyleSheet, Text, View } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'

export const SHELL_OPENING_LABEL = 'Opening workspace'

// Ease in to hold opacity while the compositor catches up with the reported renderer paint; linear fade exposed two bare-surface frames.
export const SHELL_PAGE_COVER_FADE_MS = 220

// Keep indicator and caption layout fixed so waiting screens share the same label height.
export function ShellWaitingFrame({
  label,
  indicator,
  caption
}: {
  label: string
  indicator?: ReactNode
  caption?: string
}) {
  return (
    <>
      <View style={styles.indicatorSlot}>
        {indicator ?? <ActivityIndicator color={colors.textSecondary} accessibilityLabel={label} />}
      </View>
      <View style={styles.labelRow}>
        <Text style={styles.label}>{label}</Text>
        {caption !== undefined && <Text style={styles.caption}>{caption}</Text>}
      </View>
    </>
  )
}

// Cover the mounted view until first paint, not ready; keep it noninteractive so a missing report cannot block an otherwise usable page.
export function ShellPageCover({ label, visible }: { label: string; visible: boolean }) {
  const opacity = useRef(new Animated.Value(1)).current
  const [mounted, setMounted] = useState(visible)

  useEffect(() => {
    if (visible) {
      opacity.setValue(1)
      setMounted(true)
      return
    }
    const fade = Animated.timing(opacity, {
      toValue: 0,
      duration: SHELL_PAGE_COVER_FADE_MS,
      easing: Easing.in(Easing.quad),
      useNativeDriver: true
    })
    // Unmount on animation completion; a platform-shortened fade must not strand an opaque cover, and a missing callback leaves an inert transparent one.
    fade.start(({ finished }) => {
      if (finished) {
        setMounted(false)
      }
    })
    return () => {
      fade.stop()
    }
  }, [opacity, visible])

  if (!mounted) {
    return null
  }
  return (
    <Animated.View
      style={[styles.cover, { opacity }]}
      testID="mobile-web-shell-cover"
      pointerEvents="none"
    >
      <ShellWaitingFrame label={label} />
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  cover: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgBase,
    paddingHorizontal: spacing.lg
  },
  indicatorSlot: {
    height: 20,
    justifyContent: 'center'
  },
  labelRow: {
    alignSelf: 'stretch'
  },
  label: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    marginTop: spacing.md,
    textAlign: 'center'
  },
  // Keep captions out of flow so frames with and without them center at the same height.
  caption: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    marginTop: spacing.sm,
    textAlign: 'center',
    fontSize: typography.metaSize,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  }
})
