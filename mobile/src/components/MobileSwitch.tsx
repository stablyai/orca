import { useEffect } from 'react'
import { Pressable, StyleSheet } from 'react-native'
import Animated, {
  Easing,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming
} from 'react-native-reanimated'
import { colors, motion } from '../theme/mobile-theme'
import { triggerSelection } from '../platform/haptics'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'

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
const TOGGLE_EASING = Easing.bezier(0.32, 0.72, 0, 1)

/**
 * The app's switch, drawn rather than native so it looks the same on iOS, Android and the page:
 * a translucent track that turns blue, and a white thumb that eases across.
 */
export function MobileSwitch({
  value,
  onValueChange,
  accessibilityLabel,
  disabled = false,
  testID
}: MobileSwitchProps) {
  const reducedMotion = useReducedMotionEnabled()
  const progress = useSharedValue(value ? 1 : 0)

  useEffect(() => {
    progress.value = withTiming(value ? 1 : 0, {
      duration: reducedMotion ? 0 : 260,
      easing: TOGGLE_EASING
    })
  }, [progress, reducedMotion, value])

  // Why the dependency lists: the page bundle has no worklet plugin, so web mappers read only them.
  const trackStyle = useAnimatedStyle(
    () => ({
      backgroundColor: interpolateColor(
        progress.value,
        [0, 1],
        [colors.switchTrackOff, colors.accentBlue]
      )
    }),
    [progress]
  )
  const thumbStyle = useAnimatedStyle(
    () => ({ transform: [{ translateX: interpolate(progress.value, [0, 1], [0, TRAVEL]) }] }),
    [progress]
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
      style={[styles.touch, disabled && styles.disabled]}
    >
      <Animated.View style={[styles.track, trackStyle]}>
        <Animated.View style={[styles.thumb, thumbStyle]} />
      </Animated.View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  touch: { minHeight: 44, justifyContent: 'center', flexShrink: 0 },
  disabled: { opacity: motion.disabledOpacity },
  track: {
    width: TRACK_WIDTH,
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    padding: INSET
  },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: '#ffffff',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2
  }
})
