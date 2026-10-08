import { Pressable, Text } from 'react-native'
import { Square } from 'lucide-react-native'
import { NATIVE_CHAT_TURN_STATUS_COPY } from '../../../src/shared/native-chat-turn-status'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-native-chat-view-styles'

/** The chat header's Stop. `held`: this phone's own Stop request is still in flight. */
export function MobileNativeChatStopButton({
  onStop,
  held
}: {
  onStop?: () => void
  held: boolean
}): React.JSX.Element {
  const label = held ? NATIVE_CHAT_TURN_STATUS_COPY.stopping : 'Stop'
  return (
    <Pressable
      style={({ pressed }) => [styles.stopButton, pressed && styles.pressed]}
      onPress={onStop}
      disabled={held}
      hitSlop={8}
      accessibilityLabel={held ? label : 'Stop the agent'}
    >
      <Square size={13} color={colors.statusRed} strokeWidth={2.4} fill={colors.statusRed} />
      <Text style={styles.stopLabel}>{label}</Text>
    </Pressable>
  )
}
