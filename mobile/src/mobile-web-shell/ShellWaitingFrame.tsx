import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, Animated, Easing, StyleSheet, Text, View } from 'react-native'
import { colors, spacing, textStyles } from '../theme/mobile-theme'
import { ShellStateFrame } from './ShellStateFrame'

/** What the shell calls the wait from the bytes being on disk to the page having a frame. */
export const SHELL_OPENING_LABEL = 'Opening workspace'

/**
 * Eased in, so the cover holds near full opacity through the handover: the page reports its own
 * renderer's paint, and the compositor needs a frame or two more to put that on the app's surface.
 * A linear fade left two frames of bare surface between the two on an emulator.
 */
export const SHELL_PAGE_COVER_FADE_MS = 220

/**
 * The shell's neutral frame: an indicator, a spinner unless the caller has a better one, and what it
 * is waiting on. The indicator slot and the out-of-flow caption keep the label at one height across
 * every waiting screen, whatever each one shows.
 */
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
    <View style={styles.frame}>
      <View style={styles.indicatorSlot}>
        {indicator ?? <ActivityIndicator color={colors.textSecondary} accessibilityLabel={label} />}
      </View>
      <View style={styles.labelRow}>
        <Text style={styles.label}>{label}</Text>
        {caption !== undefined && <Text style={styles.caption}>{caption}</Text>}
      </View>
    </View>
  )
}

/**
 * That same frame, held over a mounted view until the page reports one of its own: a WebView that
 * has not painted draws nothing, so uncovering at `ready` shows the surface behind it and nothing
 * else for the whole of the page's boot. Never interactive even while opaque, so a report that
 * never arrives strands a spinner over a usable page rather than a dead one.
 */
export function ShellPageCover({
  label,
  visible,
  title,
  onBack
}: {
  label: string
  visible: boolean
  /** The desktop's name, drawn where the page's own bar will paint it. */
  title?: string
  /** Drawn only, so the chevron does not blink between the waiting frame and the page. */
  onBack?: () => void
}) {
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
      <ShellStateFrame title={title} onBack={onBack}>
        <ShellWaitingFrame label={label} />
      </ShellStateFrame>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  cover: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.bgBase
  },
  frame: {
    width: '100%',
    maxWidth: 320,
    alignItems: 'center'
  },
  indicatorSlot: {
    height: 20,
    justifyContent: 'center'
  },
  labelRow: {
    alignSelf: 'stretch'
  },
  label: {
    ...textStyles.callout,
    color: colors.textSecondary,
    marginTop: spacing.md,
    textAlign: 'center'
  },
  // Out of flow, so a frame with a caption centres at the same height as one without.
  caption: {
    ...textStyles.footnote,
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    marginTop: spacing.xs,
    textAlign: 'center',
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  }
})
