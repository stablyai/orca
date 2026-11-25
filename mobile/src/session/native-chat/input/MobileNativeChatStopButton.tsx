import { Square } from 'lucide-react-native'
import { colors } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { triggerSelection } from '../../../platform/haptics/haptics'
import { MobilePendingButton } from '../../../components/controls/MobilePendingButton'
import {
  COMPOSER_CONTROL_HIT_SLOP,
  composerInputStyles as styles
} from '../../../components/composer-input/composer-input-styles'

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
    <MobilePendingButton
      label={
        held
          ? t('chat.stopButton.stoppingState', 'Stopping…')
          : t('chat.stopButton.stopAgent', 'Stop the agent')
      }
      iconOnly
      icon={
        <Square size={13} color={colors.textPrimary} strokeWidth={2.4} fill={colors.textPrimary} />
      }
      pending={held}
      pressWhilePending
      onPress={() => {
        if (onStop && !held) {
          triggerSelection()
          onStop()
        }
      }}
      style={styles.controlButton}
      spinnerColor={colors.textPrimary}
      hitSlop={COMPOSER_CONTROL_HIT_SLOP}
    />
  )
}
