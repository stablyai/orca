import { useEffect, useRef } from 'react'
import { Animated, StyleSheet, Text, View } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'

/** Animated working row; `stale` removes signals that would imply live activity. */
export function MobileAgentWorkingIndicator({
  stale = false
}: {
  stale?: boolean
}): React.JSX.Element {
  const firstDot = useRef(new Animated.Value(0.3)).current
  const secondDot = useRef(new Animated.Value(0.3)).current
  const thirdDot = useRef(new Animated.Value(0.3)).current
  const dots = [
    { id: 'first', opacity: firstDot },
    { id: 'second', opacity: secondDot },
    { id: 'third', opacity: thirdDot }
  ]

  useEffect(() => {
    if (stale) {
      return
    }
    const animations = dots.map((dot, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 160),
          Animated.timing(dot.opacity, { toValue: 1, duration: 320, useNativeDriver: true }),
          Animated.timing(dot.opacity, { toValue: 0.3, duration: 320, useNativeDriver: true })
        ])
      )
    )
    animations.forEach((a) => a.start())
    return () => animations.forEach((a) => a.stop())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stale])

  return (
    // Android announces the swap only when the live-region mode already exists.
    <View style={styles.row} accessibilityLiveRegion="polite">
      <Text style={styles.label}>{stale ? 'Agent status stale' : 'Agent is working'}</Text>
      {stale ? null : (
        <View style={styles.dots}>
          {dots.map((dot) => (
            <Animated.View key={dot.id} style={[styles.dot, { opacity: dot.opacity }]} />
          ))}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  label: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontStyle: 'italic'
  },
  dots: {
    flexDirection: 'row',
    gap: 4
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: colors.textSecondary
  }
})
