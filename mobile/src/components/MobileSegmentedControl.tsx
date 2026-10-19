import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export type MobileSegment<Value extends string> = { value: Value; label: string }

type Props<Value extends string> = {
  segments: readonly MobileSegment<Value>[]
  /** A value outside the segments selects none, e.g. one a newer host sent. */
  selected: string | undefined
  onSelect: (value: Value) => void
  /** Prefixes each segment's testID with this, then the segment's value. */
  testIDPrefix?: string
  /** Segments share the full width instead of sizing to their labels. */
  fill?: boolean
  /** The track; its default color suits a panel-colored row. */
  style?: StyleProp<ViewStyle>
  /** Shown but not pickable, e.g. while the value it sets is locked. */
  disabled?: boolean
}

/** A pick-one pill control; each segment reads as a radio button. */
export function MobileSegmentedControl<Value extends string>(props: Props<Value>) {
  return (
    <View
      style={[styles.segmented, props.style, props.disabled && styles.disabled]}
      accessibilityRole="radiogroup"
    >
      {props.segments.map((segment) => {
        const active = segment.value === props.selected
        return (
          <Pressable
            key={segment.value}
            accessibilityRole="radio"
            aria-checked={active}
            accessibilityState={{ disabled: props.disabled === true }}
            disabled={props.disabled}
            accessibilityLabel={segment.label}
            testID={props.testIDPrefix ? `${props.testIDPrefix}${segment.value}` : undefined}
            onPress={() => props.onSelect(segment.value)}
            style={[
              styles.segment,
              props.fill && styles.segmentFill,
              active && styles.segmentActive
            ]}
          >
            <Text
              style={[styles.segmentText, active && styles.segmentTextActive]}
              numberOfLines={1}
            >
              {segment.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  segmented: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgBase,
    borderRadius: radii.button,
    padding: 2
  },
  segment: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radii.button - 1
  },
  segmentFill: { flex: 1, alignItems: 'center', paddingHorizontal: spacing.xs },
  segmentActive: { backgroundColor: colors.bgRaised },
  disabled: { opacity: 0.5 },
  segmentText: { fontSize: typography.metaSize, color: colors.textSecondary, fontWeight: '600' },
  segmentTextActive: { color: colors.textPrimary }
})
