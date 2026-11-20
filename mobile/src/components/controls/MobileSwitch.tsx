import { useEffect } from 'react'
import { Pressable } from 'react-native'
import Animated, {
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming
} from 'react-native-reanimated'
import { colors, feedback, radii } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { triggerSelection } from '../../platform/haptics/haptics'
import { useReducedMotionEnabled } from '../../platform/accessibility/use-reduced-motion'
import { BOTTOM_DRAWER_EASING } from '../bottom-drawer/bottom-drawer-constants'

export type MobileSwitchProps = {
  value: boolean
  onValueChange: (value: boolean) => void
  accessibilityLabel: string
  disabled?: boolean
  testID?: string
}

const TRACK_WIDTH = 51
const TRACK_HEIGHT = 31
const THUMB = 27
const INSET = 2
const TRAVEL = TRACK_WIDTH - THUMB - INSET * 2
const TOGGLE_MS = 260
// Reaches a 44 pt target without making the row taller than its siblings.
const HIT_SLOP = { top: (44 - TRACK_HEIGHT) / 2, bottom: (44 - TRACK_HEIGHT) / 2 } as const

/** The shared switch pairs the theme's foreground track with its canvas thumb. */
export function MobileSwitch({
  value,
  onValueChange,
  accessibilityLabel,
  disabled = false,
  testID
}: MobileSwitchProps) {
  const scheme = useMobileColorScheme()
  const reducedMotion = useReducedMotionEnabled()
  const progress = useSharedValue(value ? 1 : 0)
  const offColor = colors.translucentFill
  const onColor = colors.textPrimary
  const thumbOff = scheme === 'dark' ? colors.textPrimary : colors.bgBase
  const thumbOn = colors.bgBase

  useEffect(() => {
    progress.value = withTiming(value ? 1 : 0, {
      duration: reducedMotion === true ? 0 : TOGGLE_MS,
      easing: BOTTOM_DRAWER_EASING
    })
  }, [progress, reducedMotion, value])

  // The page bundle has no worklet plugin, so web mappers read only the dependency lists.
  const trackStyle = useAnimatedStyle(
    () => ({
      backgroundColor: interpolateColor(progress.value, [0, 1], [offColor, onColor])
    }),
    [progress, offColor, onColor]
  )
  const thumbStyle = useAnimatedStyle(
    () => ({
      transform: [{ translateX: interpolate(progress.value, [0, 1], [0, TRAVEL]) }],
      backgroundColor: interpolateColor(progress.value, [0, 1], [thumbOff, thumbOn])
    }),
    [progress, thumbOff, thumbOn]
  )

  return (
    <Pressable
      onPress={() => {
        triggerSelection()
        onValueChange(!value)
      }}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value, disabled }}
      aria-checked={value}
      testID={testID}
      hitSlop={HIT_SLOP}
      style={({ pressed }) => [
        styles.touch,
        disabled && styles.disabled,
        pressed && styles.pressed
      ]}
    >
      <Animated.View style={[styles.track, trackStyle]}>
        <Animated.View style={[styles.thumb, thumbStyle]} />
      </Animated.View>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  touch: { justifyContent: 'center', flexShrink: 0 },
  disabled: { opacity: feedback.disabledOpacity },
  pressed: { opacity: feedback.pressedOpacity },
  track: {
    width: TRACK_WIDTH,
    height: TRACK_HEIGHT,
    borderRadius: radii.pill,
    padding: INSET
  },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: radii.pill,
    backgroundColor: colors.bgBase,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2
  }
}))
