import { ActivityIndicator, Pressable, StyleSheet } from 'react-native'
import { Square } from 'lucide-react-native'
import { NATIVE_CHAT_TURN_STATUS_COPY } from '../../../src/shared/native-chat-turn-status'
import { colors } from '../theme/mobile-theme'

/** The composer's Stop, in Send's slot. `held`: this phone's own Stop request is still in flight. */
export function MobileNativeChatStopButton({
  onStop,
  held
}: {
  onStop?: () => void
  held: boolean
}): React.JSX.Element {
  return (
    <Pressable
      style={({ pressed }) => [styles.stopButton, pressed && styles.pressed]}
      onPress={onStop}
      disabled={held}
      accessibilityRole="button"
      accessibilityLabel={held ? NATIVE_CHAT_TURN_STATUS_COPY.stopping : 'Stop the agent'}
    >
      {held ? (
        <ActivityIndicator size="small" color={colors.statusRed} />
      ) : (
        <Square size={16} color={colors.statusRed} strokeWidth={2.4} fill={colors.statusRed} />
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  stopButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  pressed: {
    opacity: 0.7
  }
})
