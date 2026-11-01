import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { colors, concentricRadius, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

export type MobileSegment<Value extends string> = {
  value: Value
  label: string
  /** A longer spoken name where the short label leans on its surroundings. */
  accessibilityLabel?: string
}

type Props<Value extends string> = {
  segments: readonly MobileSegment<Value>[]
  /** A value outside the segments selects none, e.g. one a newer host sent. */
  selected: string | undefined
  onSelect: (value: Value) => void
  /** Prefixes each segment's testID with this, then the segment's value. */
  testIDPrefix?: string
  /** Segments share the full width instead of sizing to their labels. */
  fill?: boolean
  /** Paints the track like a sheet's grouped rows, so it stands out from the sheet. */
  onSheet?: boolean
  /** The track; its default color suits a panel-colored row. */
  style?: StyleProp<ViewStyle>
  /** Shown but not pickable, e.g. while the value it sets is locked. */
  disabled?: boolean
}

/** A pick-one pill control; each segment reads as a radio button. */
export function MobileSegmentedControl<Value extends string>(props: Props<Value>) {
  useMobileColorScheme()
  return (
    <View
      style={[styles.segmented, props.onSheet && styles.segmentedOnSheet, props.style]}
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
            accessibilityLabel={segment.accessibilityLabel ?? segment.label}
            testID={props.testIDPrefix ? `${props.testIDPrefix}${segment.value}` : undefined}
            onPress={() => props.onSelect(segment.value)}
            style={[
              styles.segment,
              props.fill && styles.segmentFill,
              active && (props.onSheet ? styles.segmentActiveOnSheet : styles.segmentActive)
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

const TRACK_INSET = 3

const styles = themedStyleSheet(() => ({
  segmented: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgBase,
    borderRadius: radii.control,
    padding: TRACK_INSET
  },
  // Room above and below the label, so it doesn't sit against the track's edges.
  segment: {
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: concentricRadius(radii.control, TRACK_INSET)
  },
  segmentFill: { flex: 1, alignItems: 'center', paddingHorizontal: spacing.xs },
  segmentedOnSheet: { backgroundColor: colors.sheetGroup },
  segmentActive: { backgroundColor: colors.bgRaised },
  // bgRaised is the sheet group's own color in dark; the switch's grey fill lifts off it in both themes.
  segmentActiveOnSheet: { backgroundColor: colors.translucentFill },
  segmentText: { fontSize: 13, color: colors.textSecondary, fontWeight: '600' },
  segmentTextActive: { color: colors.textPrimary }
}))
