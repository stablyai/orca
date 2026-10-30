import { ActivityIndicator, Pressable } from 'react-native'
import { Square } from 'lucide-react-native'
import { colors } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { mobileNativeChatComposerStyles as styles } from '../composer/mobile-native-chat-composer-styles'

// held tracks this phone’s in-flight Stop request, not the host’s stopping status.
export function MobileNativeChatStopButton({
  onStop,
  held
}: {
  onStop?: () => void
  held: boolean
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <Pressable
      style={({ pressed }) => [styles.controlButton, pressed && styles.pressed]}
      onPress={onStop}
      disabled={held}
      accessibilityRole="button"
      accessibilityLabel={
        held
          ? t('chat.stopButton.stoppingState', 'Stopping…')
          : t('chat.stopButton.stopAgent', 'Stop the agent')
      }
    >
      {held ? (
        <ActivityIndicator size="small" color={colors.textPrimary} />
      ) : (
        <Square size={13} color={colors.textPrimary} strokeWidth={2.4} fill={colors.textPrimary} />
      )}
    </Pressable>
  )
}
