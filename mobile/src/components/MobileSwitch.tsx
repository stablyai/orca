import { useEffect } from 'react'
import { Pressable } from 'react-native'
import Animated, {
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming
} from 'react-native-reanimated'
import { colors, radii } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { triggerSelection } from '../platform/haptics'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { BOTTOM_DRAWER_EASING } from './bottom-drawer-constants'

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
  useMobileColorScheme()
  const reducedMotion = useReducedMotionEnabled()
  const progress = useSharedValue(value ? 1 : 0)
  const offColor = colors.translucentFill
  const onColor = colors.accentBlue

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

const styles = themedStyleSheet(() => ({
  touch: { minHeight: 44, justifyContent: 'center', flexShrink: 0 },
  disabled: { opacity: 0.4 },
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
    backgroundColor: '#ffffff',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2
  }
}))
