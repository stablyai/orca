import { useEffect, useRef } from 'react'
import { Animated, Easing, Platform, Pressable, View } from 'react-native'
import { ArrowDown, ArrowUp } from 'lucide-react-native'
import { SHEET_CURVE } from '../../../components/motion/sheet-motion-values'
import { useReducedMotionEnabled } from '../../../platform/accessibility/use-reduced-motion'
import { colors, feedback } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { styles } from '../mobile-native-chat-view-styles'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'

const JUMP_EASING = Easing.bezier(...SHEET_CURVE)

function FloatingChatButton({
  visible,
  label,
  icon: Icon,
  onPress
}: {
  visible: boolean
  label: string
  icon: typeof ArrowDown
  onPress: () => void
}): React.JSX.Element {
  const reducedMotion = useReducedMotionEnabled() === true
  const shown = useRef(new Animated.Value(visible ? 1 : 0)).current
  // Stays mounted so a scroll that flips it mid-fade turns the fade around instead of popping.
  useEffect(() => {
    const animation = Animated.timing(shown, {
      toValue: visible ? 1 : 0,
      duration: visible ? 160 : 120,
      easing: JUMP_EASING,
      useNativeDriver: Platform.OS !== 'web'
    })
    animation.start()
    return () => animation.stop()
  }, [visible, shown])
  const scale = reducedMotion ? 1 : shown.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] })
  return (
    <Pressable
      pointerEvents={visible ? 'auto' : 'none'}
      aria-hidden={!visible}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={!visible}
      focusable={visible}
      hitSlop={3}
      style={({ pressed }) => [styles.fabTarget, pressed && { opacity: feedback.pressedOpacity }]}
      onPress={onPress}
    >
      <Animated.View style={[styles.fab, { opacity: shown, transform: [{ scale }] }]}>
        <Icon size={18} color={colors.textPrimary} strokeWidth={2.2} />
      </Animated.View>
    </Pressable>
  )
}

export function MobileNativeChatFloatingControls({
  showJumpToTail,
  onJumpToTail,
  previousPrompt
}: {
  showJumpToTail: boolean
  onJumpToTail: () => void
  previousPrompt?: { visible: boolean; onPress: () => void }
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View pointerEvents="box-none" style={styles.floatingControls}>
      {previousPrompt && (
        <FloatingChatButton
          {...previousPrompt}
          label={t(
            'session.nativeChatFloatingControls.scrollToPreviousPrompt',
            'Scroll to previous prompt'
          )}
          icon={ArrowUp}
        />
      )}
      <FloatingChatButton
        visible={showJumpToTail}
        label={t('session.nativeChatFloatingControls.scrollToLatest', 'Scroll to latest')}
        icon={ArrowDown}
        onPress={onJumpToTail}
      />
    </View>
  )
}
