import { Animated, StyleSheet, Text, View } from 'react-native'
import { Hourglass, LoaderCircle } from 'lucide-react-native'
import { colors, spacing, textStyles } from '../theme/mobile-theme'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { useWorkingRingRotation } from './use-working-ring-rotation'

/** Desktop's LoadingSpinner: the same turning circle, once per second.
 *  Why: a spinner frozen by reduced motion reads as stuck, so the still state is
 *  a different icon that says "working" without moving. */
export function LoadingSpinner({
  size,
  color,
  label
}: {
  size: number
  color: string
  /** Names the stage beside the spinner, e.g. "Connecting to MacBook Pro…". */
  label?: string
}): React.JSX.Element {
  const reducedMotion = useReducedMotionEnabled()
  const rotate = useWorkingRingRotation(reducedMotion === false)
  const glyph = reducedMotion ? (
    <Hourglass size={size} color={color} strokeWidth={2} />
  ) : (
    <Animated.View style={{ transform: [{ rotate }] }}>
      <LoaderCircle size={size} color={color} strokeWidth={2} />
    </Animated.View>
  )
  if (label === undefined) {
    return glyph
  }
  return (
    <View style={styles.row} accessibilityRole="progressbar" accessibilityLabel={label}>
      {glyph}
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  label: { ...textStyles.callout, color: colors.textSecondary, flexShrink: 1 }
})
