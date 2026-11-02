import { ActivityIndicator, Pressable } from 'react-native'
import { Square } from 'lucide-react-native'
import { colors } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import {
  COMPOSER_CONTROL_HIT_SLOP,
  composerInputStyles as styles
} from '../../../components/composer-input/composer-input-styles'
import { MobileNativeChatControlSwap } from './mobile-native-chat-control-swap'

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
      hitSlop={COMPOSER_CONTROL_HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={
        held
          ? t('chat.stopButton.stoppingState', 'Stopping…')
          : t('chat.stopButton.stopAgent', 'Stop the agent')
      }
    >
      <MobileNativeChatControlSwap swapKey={held ? 'held' : 'stop'} icon>
        {held ? (
          <ActivityIndicator size="small" color={colors.textPrimary} />
        ) : (
          <Square
            size={13}
            color={colors.textPrimary}
            strokeWidth={2.4}
            fill={colors.textPrimary}
          />
        )}
      </MobileNativeChatControlSwap>
    </Pressable>
  )
}
