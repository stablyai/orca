import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Animated, Easing, StyleSheet, Text } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'

/** What the shell calls the wait from the bytes being on disk to the page having a frame. */
export const SHELL_OPENING_LABEL = 'Opening workspace'

/**
 * Eased in, so the cover holds near full opacity through the handover: the page reports its own
 * renderer's paint, and the compositor needs a frame or two more to put that on the app's surface.
 * A linear fade left two frames of bare surface between the two on an emulator.
 */
export const SHELL_PAGE_COVER_FADE_MS = 220

/** The shell's neutral frame: one spinner and what it is waiting on. */
export function ShellWaitingFrame({ label }: { label: string }) {
  return (
    <>
      <ActivityIndicator color={colors.textSecondary} accessibilityLabel={label} />
      <Text style={styles.label}>{label}</Text>
    </>
  )
}

/**
 * That same frame, held over a mounted view until the page reports one of its own: a WebView that
 * has not painted draws nothing, so uncovering at `ready` shows the surface behind it and nothing
 * else for the whole of the page's boot. Never interactive even while opaque, so a report that
 * never arrives strands a spinner over a usable page rather than a dead one.
 */
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
    // Unmounted on the callback rather than on a timer, so a fade the platform cut short does not
    // leave an opaque cover behind; one that never calls back leaves a transparent inert one.
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
  label: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    marginTop: spacing.md,
    textAlign: 'center'
  }
})
