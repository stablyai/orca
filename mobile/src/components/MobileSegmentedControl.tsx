import { useEffect, useRef, useState } from 'react'
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type ScrollViewInstance,
  type StyleProp,
  type ViewStyle
} from 'react-native'
import { triggerSelection } from '../platform/haptics'
import { resolveTabStripScrollOffset } from '../session/tabs/tab-strip-scroll'
import { colors, concentricRadius, feedback, radii, spacing } from '../theme/mobile-theme'
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
  /** Like `fill`, but labels too long for an equal share widen their segment and the track scrolls. */
  scrollWhenCrowded?: boolean
  /** Paints the track like a sheet's grouped rows, so it stands out from the sheet. */
  onSheet?: boolean
  /** The track; its default color suits a panel-colored row. */
  style?: StyleProp<ViewStyle>
  /** Shown but not pickable, e.g. while the value it sets is locked. */
  disabled?: boolean
  /** The segments switch the content below, so screen readers hear tabs instead of radio buttons. */
  tabs?: boolean
}

/** A pick-one pill control; each segment reads as a radio button, or as a tab with `tabs`. */
export function MobileSegmentedControl<Value extends string>(props: Props<Value>) {
  useMobileColorScheme()
  const [trackWidth, setTrackWidth] = useState(0)
  const scrollRef = useRef<ScrollViewInstance>(null)
  const scrollX = useRef(0)
  const [widths] = useState(() => new Map<string, number>())
  const revealSelected = (): void => {
    if (!scrollRef.current || trackWidth === 0) {
      return
    }
    const span = segmentSpan(props.segments, widths, props.selected)
    if (span) {
      const x = resolveTabStripScrollOffset({
        ...span,
        viewportWidth: trackWidth,
        currentOffset: scrollX.current,
        margin: TRACK_INSET
      })
      scrollRef.current.scrollTo({ x, animated: false })
    }
  }
  const segmentValues = props.segments.map((segment) => segment.value).join('\n')

  // Not on every render: a re-render must not undo the user's own scroll.
  useEffect(revealSelected, [props.selected, trackWidth, segmentValues])

  // Equal shares that exactly fill the track while every label fits.
  const equalShare = props.scrollWhenCrowded &&
    trackWidth > 0 && {
      minWidth: Math.floor((trackWidth - 2 * TRACK_INSET) / props.segments.length)
    }
  const accessibilityRole = props.tabs ? 'tablist' : 'radiogroup'
  const segments = props.segments.map((segment) => {
    const active = segment.value === props.selected
    return (
      <Pressable
        key={segment.value}
        onLayout={
          props.scrollWhenCrowded
            ? (event) => {
                // Widths, not x: web reports only size changes, so a shifted segment's x goes stale.
                widths.set(segment.value, event.nativeEvent.layout.width)
                revealSelected()
              }
            : undefined
        }
        accessibilityRole={props.tabs ? 'tab' : 'radio'}
        aria-checked={props.tabs ? undefined : active}
        accessibilityState={{
          disabled: props.disabled === true,
          ...(props.tabs ? { selected: active } : {})
        }}
        disabled={props.disabled}
        accessibilityLabel={segment.accessibilityLabel ?? segment.label}
        testID={props.testIDPrefix ? `${props.testIDPrefix}${segment.value}` : undefined}
        onPress={() => {
          if (!active) {
            triggerSelection()
          }
          props.onSelect(segment.value)
        }}
        // Stretches the 34 pt segment to a 44 pt touch box.
        hitSlop={{ top: 5, bottom: 5 }}
        style={({ pressed }) => [
          styles.segment,
          props.fill && !props.scrollWhenCrowded && styles.segmentFill,
          props.scrollWhenCrowded && styles.segmentCrowdable,
          equalShare,
          active && (props.onSheet ? styles.segmentActiveOnSheet : styles.segmentActive),
          pressed && !active && styles.segmentPressed
        ]}
      >
        <Text style={[styles.segmentText, active && styles.segmentTextActive]} numberOfLines={1}>
          {segment.label}
        </Text>
      </Pressable>
    )
  })
  const sheetStyle = props.onSheet && styles.segmentedOnSheet
  if (!props.scrollWhenCrowded) {
    return (
      <View
        style={[styles.segmented, sheetStyle, props.style]}
        accessibilityRole={accessibilityRole}
      >
        {segments}
      </View>
    )
  }
  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      // Fitting segments shouldn't rubber-band sideways on iOS.
      alwaysBounceHorizontal={false}
      showsHorizontalScrollIndicator={false}
      style={[styles.scrollTrack, sheetStyle, props.style]}
      contentContainerStyle={styles.scrollContent}
      accessibilityRole={accessibilityRole}
      onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
      onScroll={(event) => {
        scrollX.current = event.nativeEvent.contentOffset.x
      }}
      scrollEventThrottle={16}
    >
      {segments}
    </ScrollView>
  )
}

const TRACK_INSET = 3

/** Where the selected segment sits in the scrolled content, once every segment has a width. */
function segmentSpan(
  segments: readonly MobileSegment<string>[],
  widths: ReadonlyMap<string, number>,
  selected: string | undefined
): { tabX: number; tabWidth: number; contentWidth: number } | undefined {
  let left = TRACK_INSET
  let span: { tabX: number; tabWidth: number } | undefined
  for (const segment of segments) {
    const width = widths.get(segment.value)
    if (width === undefined) {
      return undefined
    }
    if (segment.value === selected) {
      span = { tabX: left, tabWidth: width }
    }
    left += width
  }
  return span && { ...span, contentWidth: left + TRACK_INSET }
}

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
  segmentCrowdable: { flexGrow: 1, alignItems: 'center', paddingHorizontal: spacing.xs },
  // The inset sits on the content, so segments scroll out under the track's rounded edge.
  scrollTrack: { flexGrow: 0, backgroundColor: colors.bgBase, borderRadius: radii.control },
  scrollContent: { flexGrow: 1, alignItems: 'center', padding: TRACK_INSET },
  segmentedOnSheet: { backgroundColor: colors.sheetGroup },
  segmentActive: { backgroundColor: colors.bgRaised },
  // bgRaised is the sheet group's own color in dark; the switch's grey fill lifts off it in both themes.
  segmentActiveOnSheet: { backgroundColor: colors.translucentFill },
  segmentText: { fontSize: 13, color: colors.textSecondary, fontWeight: '600' },
  segmentTextActive: { color: colors.textPrimary },
  segmentPressed: { opacity: feedback.pressedOpacity }
}))
