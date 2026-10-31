import { ActivityIndicator, Pressable } from 'react-native'
import { ArrowUp, type LucideIcon } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { composerInputStyles as styles } from './composer-input-styles'

export function ComposerSendButton({
  onPress,
  onLongPress,
  canSend,
  sending = false,
  label = 'Send',
  icon: Icon = ArrowUp
}: {
  onPress: () => void
  /** A hold offers more ways to send; absent, a hold is a plain press. */
  onLongPress?: () => void
  canSend: boolean
  sending?: boolean
  label?: string
  /** What a tap does when it isn't a plain send. */
  icon?: LucideIcon
}): React.JSX.Element {
  useMobileColorScheme()
  const enabled = canSend && !sending
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled, busy: sending }}
      // react-native-web maps aria-busy but not accessibilityState.busy.
      aria-busy={sending}
      style={({ pressed }) => [
        styles.sendButton,
        !canSend && styles.sendButtonDisabled,
        pressed && enabled && styles.pressed
      ]}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!enabled}
    >
      {sending ? (
        <ActivityIndicator size="small" color={colors.bgBase} />
      ) : (
        <Icon size={19} color={canSend ? colors.bgBase : colors.textMuted} strokeWidth={2.4} />
      )}
    </Pressable>
  )
}
