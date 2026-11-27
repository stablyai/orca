import { ArrowUp } from 'lucide-react-native'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { MobilePendingButton } from '../controls/MobilePendingButton'
import {
  COMPOSER_COMPACT_CONTROL_HIT_SLOP,
  COMPOSER_CONTROL_HIT_SLOP,
  composerInputStylesSheet
} from './composer-input-styles'
import { useThemedStyles } from '../../theme/themed-styles'

export function ComposerSendButton({
  onPress,
  onLongPress,
  canSend,
  sending = false,
  label = 'Send',
  size = 'default'
}: {
  onPress: () => void
  /** A hold offers more ways to send; absent, a hold is a plain press. */
  onLongPress?: () => void
  canSend: boolean
  sending?: boolean
  label?: string
  /** `compact` fits a one-line box's text row. */
  size?: 'default' | 'compact'
}): React.JSX.Element {
  const styles = useThemedStyles(composerInputStylesSheet)
  const colors = useMobileColors()
  const compact = size === 'compact'
  return (
    <MobilePendingButton
      label={label}
      iconOnly
      icon={
        <ArrowUp
          size={compact ? 15 : 19}
          color={canSend ? colors.bgBase : colors.textMuted}
          strokeWidth={2.4}
        />
      }
      pending={sending}
      disabled={!canSend}
      onPress={onPress}
      onLongPress={onLongPress}
      style={[styles.sendButton, compact && styles.compactSendButton]}
      // Nothing to send is Send's own empty look, not the locked-control dim.
      disabledStyle={styles.sendButtonDisabled}
      spinnerColor={colors.bgBase}
      hitSlop={compact ? COMPOSER_COMPACT_CONTROL_HIT_SLOP : COMPOSER_CONTROL_HIT_SLOP}
    />
  )
}
