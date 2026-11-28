import { Play } from 'lucide-react-native'
import { spacing } from '../../../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../../../theme/themed-styles'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { MobileNativeChatNoticePill } from './MobileNativeChatNoticePill'

export function MobileNativeChatInterruptedContinueButton({
  onPress
}: {
  onPress: () => void
}): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  return (
    <MobileNativeChatNoticePill
      label={t('common.continue', 'Continue')}
      Icon={Play}
      accessibilityHint={t(
        'chat.interruptedContinue.explanation',
        'Continue, and the agent first checks whether its last step finished.'
      )}
      onPress={onPress}
      style={styles.button}
    />
  )
}

const stylesSheet = themedStyleSheet(() => ({
  button: {
    alignSelf: 'flex-start',
    marginTop: spacing.sm
  }
}))
