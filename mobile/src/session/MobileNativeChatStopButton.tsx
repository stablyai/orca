import { ActivityIndicator, Pressable } from 'react-native'
import { Square } from 'lucide-react-native'
import { NATIVE_CHAT_TURN_STATUS_COPY } from '../../../src/shared/native-chat-turn-status'
import { colors } from '../theme/mobile-theme'
import { mobileNativeChatComposerStyles as styles } from './mobile-native-chat-composer-styles'

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
      style={({ pressed }) => [styles.controlButton, pressed && styles.pressed]}
      onPress={onStop}
      disabled={held}
      accessibilityRole="button"
      accessibilityLabel={held ? NATIVE_CHAT_TURN_STATUS_COPY.stopping : 'Stop the agent'}
    >
      {held ? (
        <ActivityIndicator size="small" color={colors.textPrimary} />
      ) : (
        <Square size={13} color={colors.textPrimary} strokeWidth={2.4} fill={colors.textPrimary} />
      )}
    </Pressable>
  )
}
