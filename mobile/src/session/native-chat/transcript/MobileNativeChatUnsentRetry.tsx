import { RotateCcw } from 'lucide-react-native'
import { spacing } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { MobileNativeChatNoticePill } from './MobileNativeChatNoticePill'

/** Re-sends a send whose start the agent refused for want of a login. */
export function MobileNativeChatUnsentRetry({
  onPress
}: {
  onPress: () => void
}): React.JSX.Element {
  const t = useMobileTranslation()
  return (
    <MobileNativeChatNoticePill
      label={t('common.retry', 'Retry')}
      Icon={RotateCcw}
      onPress={onPress}
      style={styles.button}
    />
  )
}

const styles = themedStyleSheet(() => ({
  button: {
    marginTop: spacing.xs
  }
}))
