import { useState } from 'react'
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutRectangle,
  type StyleProp,
  type ViewStyle
} from 'react-native'
import { colors, radii, textStyles } from '../theme/mobile-theme'
import { triggerSelection } from '../platform/haptics'
import { slideTransition } from './ui/transition-styles'

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
  /** The track. */
  style?: StyleProp<ViewStyle>
  /** Shown but not pickable, e.g. while the value it sets is locked. */
  disabled?: boolean
}

const PADDING = 3

/** A pick-one capsule control; each segment reads as a radio button and the thumb slides to it. */
export function MobileSegmentedControl<Value extends string>(props: Props<Value>) {
  const [frames, setFrames] = useState<Readonly<Record<string, LayoutRectangle>>>({})
  const thumb = props.selected === undefined ? undefined : frames[props.selected]
  // Five or more shared segments get a tighter label so words like "Extra high" still fit a phone.
  const dense = props.fill === true && props.segments.length >= 5
  return (
    <View
      style={[styles.track, props.disabled && styles.disabled, props.style]}
      accessibilityRole="radiogroup"
    >
      {thumb ? (
        <View
          pointerEvents="none"
          style={[
            styles.thumb,
            { width: thumb.width, transform: [{ translateX: thumb.x - PADDING }] },
            slideTransition
          ]}
        />
      ) : null}
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
            onLayout={(event) => {
              const frame = event.nativeEvent.layout
              setFrames((current) => ({ ...current, [segment.value]: frame }))
            }}
            onPress={() => {
              if (!active) {
                triggerSelection()
              }
              props.onSelect(segment.value)
            }}
            style={({ pressed }) => [
              styles.segment,
              props.fill && styles.segmentFill,
              dense && styles.segmentDense,
              // The thumb lands after the first layout; until then the segment paints itself.
              active && !thumb && styles.segmentActive,
              pressed && !active && styles.segmentPressed
            ]}
          >
            <Text
              style={[
                styles.segmentText,
                dense && styles.segmentTextDense,
                active && styles.segmentTextActive
              ]}
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
  track: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 36,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: radii.pill,
    padding: PADDING
  },
  disabled: { opacity: 0.5 },
  thumb: {
    position: 'absolute',
    top: PADDING,
    bottom: PADDING,
    left: PADDING,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(255, 255, 255, 0.17)'
  },
  segment: {
    minHeight: 30,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: radii.pill
  },
  segmentFill: { flex: 1, alignItems: 'center', paddingHorizontal: 6 },
  segmentDense: { paddingHorizontal: 2 },
  segmentActive: { backgroundColor: 'rgba(255, 255, 255, 0.17)' },
  segmentPressed: { opacity: 0.6 },
  segmentText: { ...textStyles.subhead, fontWeight: '500', color: colors.textSecondary },
  segmentTextDense: { ...textStyles.footnote, fontWeight: '500' },
  segmentTextActive: { color: colors.textPrimary }
})
