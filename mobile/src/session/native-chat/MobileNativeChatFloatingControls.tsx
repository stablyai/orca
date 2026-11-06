import { useEffect, useRef } from 'react'
import { Animated, Easing, Platform, Pressable, View } from 'react-native'
import { ArrowDown } from 'lucide-react-native'
import { SHEET_CURVE } from '../../components/sheet-motion-values'
import { useReducedMotionEnabled } from '../../platform/use-reduced-motion'
import { colors, feedback } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { styles } from './mobile-native-chat-view-styles'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'

const JUMP_EASING = Easing.bezier(...SHEET_CURVE)

export function MobileNativeChatFloatingControls({
  showJumpToTail,
  onJumpToTail
}: {
  showJumpToTail: boolean
  onJumpToTail: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const reducedMotion = useReducedMotionEnabled() === true
  const shown = useRef(new Animated.Value(showJumpToTail ? 1 : 0)).current
  // Stays mounted so a scroll that flips it mid-fade turns the fade around instead of popping.
  useEffect(() => {
    const animation = Animated.timing(shown, {
      toValue: showJumpToTail ? 1 : 0,
      duration: showJumpToTail ? 160 : 120,
      easing: JUMP_EASING,
      useNativeDriver: Platform.OS !== 'web'
    })
    animation.start()
    return () => animation.stop()
  }, [showJumpToTail, shown])
  const scale = reducedMotion ? 1 : shown.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] })
  return (
    <View pointerEvents="box-none" style={styles.floatingControls}>
      <Animated.View
        pointerEvents={showJumpToTail ? 'box-none' : 'none'}
        accessibilityElementsHidden={!showJumpToTail}
        importantForAccessibility={showJumpToTail ? 'auto' : 'no-hide-descendants'}
        style={{ opacity: shown, transform: [{ scale }] }}
      >
        <Pressable
          accessibilityLabel={
            showJumpToTail
              ? t('session.nativeChatFloatingControls.scrollToLatest', 'Scroll to latest')
              : undefined
          }
          disabled={!showJumpToTail}
          focusable={showJumpToTail}
          style={({ pressed }) => [styles.fab, pressed && { opacity: feedback.pressedOpacity }]}
          onPress={onJumpToTail}
        >
          <ArrowDown size={18} color={colors.textPrimary} strokeWidth={2.2} />
        </Pressable>
      </Animated.View>
    </View>
  )
}
