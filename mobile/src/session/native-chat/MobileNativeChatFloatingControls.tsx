import { useEffect, useRef, type ReactNode } from 'react'
import { Animated, Easing, Platform, Pressable, View } from 'react-native'
import { ArrowDown, ArrowUp } from 'lucide-react-native'
import { SHEET_CURVE } from '../../components/sheet-motion-values'
import { useReducedMotionEnabled } from '../../platform/use-reduced-motion'
import { colors, feedback } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { NATIVE_CHAT_FAB_GAP, NATIVE_CHAT_FAB_SIZE, styles } from './mobile-native-chat-view-styles'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'

const JUMP_EASING = Easing.bezier(...SHEET_CURVE)
const FAB_LIFT = NATIVE_CHAT_FAB_SIZE + NATIVE_CHAT_FAB_GAP

function useShown(shown: boolean): Animated.Value {
  const value = useRef(new Animated.Value(shown ? 1 : 0)).current
  const reducedMotion = useReducedMotionEnabled() === true
  useEffect(() => {
    if (reducedMotion) {
      value.setValue(shown ? 1 : 0)
      return
    }
    const animation = Animated.timing(value, {
      toValue: shown ? 1 : 0,
      duration: shown ? 160 : 120,
      easing: JUMP_EASING,
      useNativeDriver: Platform.OS !== 'web'
    })
    animation.start()
    return () => animation.stop()
  }, [reducedMotion, shown, value])
  return value
}

function ChatJumpButton({
  shown,
  shownValue,
  bottom,
  label,
  onPress,
  icon
}: {
  shown: boolean
  shownValue: Animated.Value
  bottom: number | Animated.AnimatedInterpolation<number>
  label: string
  onPress: () => void
  icon: ReactNode
}): React.JSX.Element {
  const reducedMotion = useReducedMotionEnabled() === true
  const scale = reducedMotion
    ? 1
    : shownValue.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] })
  return (
    <Animated.View
      pointerEvents={shown ? 'box-none' : 'none'}
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? 'auto' : 'no-hide-descendants'}
      style={{
        position: 'absolute',
        right: 0,
        bottom,
        opacity: shownValue,
        transform: [{ scale }]
      }}
    >
      <Pressable
        accessibilityLabel={shown ? label : undefined}
        disabled={!shown}
        focusable={shown}
        style={({ pressed }) => [styles.fab, pressed && { opacity: feedback.pressedOpacity }]}
        onPress={onPress}
      >
        {icon}
      </Pressable>
    </Animated.View>
  )
}

export function MobileNativeChatFloatingControls({
  showJumpToTail,
  onJumpToTail,
  showPreviousMessage,
  onJumpToPrevious
}: {
  showJumpToTail: boolean
  onJumpToTail: () => void
  showPreviousMessage: boolean
  onJumpToPrevious: (animated: boolean) => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const reducedMotion = useReducedMotionEnabled() === true
  const tailShown = useShown(showJumpToTail)
  const previousShown = useShown(showPreviousMessage)
  // Separate from the native-driver fade: `bottom` cannot run on the native driver.
  const tailLift = useRef(new Animated.Value(showJumpToTail ? 1 : 0)).current
  useEffect(() => {
    if (reducedMotion) {
      tailLift.setValue(showJumpToTail ? 1 : 0)
      return
    }
    const animation = Animated.timing(tailLift, {
      toValue: showJumpToTail ? 1 : 0,
      duration: showJumpToTail ? 160 : 120,
      easing: JUMP_EASING,
      useNativeDriver: false
    })
    animation.start()
    return () => animation.stop()
  }, [reducedMotion, showJumpToTail, tailLift])
  // Sit on the latest button while it is visible, then drop into its place when it hides.
  const previousBottom = tailLift.interpolate({
    inputRange: [0, 1],
    outputRange: [0, FAB_LIFT]
  })
  return (
    <View pointerEvents="box-none" style={styles.floatingControls}>
      <ChatJumpButton
        shown={showPreviousMessage}
        shownValue={previousShown}
        bottom={previousBottom}
        label={t('session.nativeChatFloatingControls.previousMessage', 'Previous message')}
        onPress={() => onJumpToPrevious(!reducedMotion)}
        icon={<ArrowUp size={18} color={colors.textPrimary} strokeWidth={2.2} />}
      />
      <ChatJumpButton
        shown={showJumpToTail}
        shownValue={tailShown}
        bottom={0}
        label={t('session.nativeChatFloatingControls.scrollToLatest', 'Scroll to latest')}
        onPress={onJumpToTail}
        icon={<ArrowDown size={18} color={colors.textPrimary} strokeWidth={2.2} />}
      />
    </View>
  )
}
