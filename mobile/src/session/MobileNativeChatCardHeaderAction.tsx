import { Keyboard, Pressable, StyleSheet, View } from 'react-native'
import { ChevronDown, X } from 'lucide-react-native'
import { colors, MIN_TOUCH_TARGET, motion } from '../theme/mobile-theme'
import { pressTransition } from '../components/ui/transition-styles'

const CIRCLE = 32

/** A prompt card's header action: Cancel where the lane can cancel, else a Collapse that writes nothing. */
export function MobileNativeChatCardHeaderAction<Prompt>({
  prompt,
  onCancel,
  onCollapse,
  disabled
}: {
  prompt?: Prompt
  onCancel?: (prompt?: Prompt) => Promise<boolean>
  onCollapse?: () => void
  disabled?: boolean
}): React.JSX.Element | null {
  if (!onCancel && !onCollapse) {
    return null
  }
  const Icon = onCancel ? X : ChevronDown
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={onCancel ? 'Cancel' : 'Collapse'}
      accessibilityState={onCancel ? { disabled: disabled === true } : { expanded: true }}
      style={[styles.touch, disabled && styles.disabled]}
      onPress={() => {
        if (onCancel) {
          void onCancel(prompt)
          return
        }
        // Why: a reply field hidden by the collapse must not keep the keyboard up.
        Keyboard.dismiss()
        onCollapse?.()
      }}
      disabled={disabled}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.circle,
            pressed && styles.pressed,
            pressed ? pressTransition.pressed : pressTransition.rest
          ]}
        >
          <Icon size={18} color={colors.textSecondary} strokeWidth={2.2} />
        </View>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  // Overhangs the card's padding so the 44 pt box does not push the header taller.
  touch: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    margin: -6,
    alignItems: 'center',
    justifyContent: 'center'
  },
  disabled: { opacity: motion.disabledOpacity },
  circle: {
    width: CIRCLE,
    height: CIRCLE,
    borderRadius: CIRCLE / 2,
    alignItems: 'center',
    justifyContent: 'center'
  },
  pressed: {
    backgroundColor: colors.fill,
    transform: [{ scale: motion.pressedIconScale }]
  }
})
