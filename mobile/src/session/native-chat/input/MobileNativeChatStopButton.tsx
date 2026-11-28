import { Square } from 'lucide-react-native'
import { useMobileColors } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { triggerSelection } from '../../../platform/haptics/haptics'
import { MobilePendingButton } from '../../../components/controls/MobilePendingButton'
import {
  COMPOSER_CONTROL_HIT_SLOP,
  composerInputStylesSheet
} from '../../../components/composer-input/composer-input-styles'
import { useThemedStyles } from '../../../theme/themed-styles'

// held tracks this phone’s in-flight Stop request, not the host’s stopping status.
export function MobileNativeChatStopButton({
  onStop,
  held
}: {
  onStop?: () => void
  held: boolean
}): React.JSX.Element {
  const styles = useThemedStyles(composerInputStylesSheet)
  const colors = useMobileColors()
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
      onPress={() => {
        // Every Stop press sends; a terminal chat's Stop ends the turn at once, so it has no wait to show.
        if (onStop) {
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
