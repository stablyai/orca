import { Pressable, StyleSheet, View } from 'react-native'
import { ArrowDown } from 'lucide-react-native'
import { colors, MIN_TOUCH_TARGET, motion } from '../theme/mobile-theme'
import { pressTransition } from '../components/ui/transition-styles'
import { styles as viewStyles } from './mobile-native-chat-view-styles'

const CIRCLE = 40

/** Floats over the transcript's bottom-right so jump-to-latest takes no row. */
export function MobileNativeChatFloatingControls({
  showJumpToTail,
  onJumpToTail
}: {
  showJumpToTail: boolean
  onJumpToTail: () => void
}): React.JSX.Element {
  return (
    <View pointerEvents="box-none" style={viewStyles.floatingControls}>
      {showJumpToTail ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Scroll to latest"
          style={styles.touch}
          onPress={onJumpToTail}
        >
          {({ pressed }) => (
            // Opaque, unlike the composer's controls: it floats over the transcript's text.
            <View
              style={[
                styles.circle,
                pressed && styles.pressed,
                pressed ? pressTransition.pressed : pressTransition.rest
              ]}
            >
              <ArrowDown size={18} color={colors.textPrimary} strokeWidth={2.2} />
            </View>
          )}
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  touch: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center'
  },
  circle: {
    width: CIRCLE,
    height: CIRCLE,
    borderRadius: CIRCLE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.separator
  },
  pressed: {
    backgroundColor: colors.borderSubtle,
    transform: [{ scale: motion.pressedIconScale }]
  }
})
