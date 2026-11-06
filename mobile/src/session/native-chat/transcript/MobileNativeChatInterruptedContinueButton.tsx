import { Pressable, Text } from 'react-native'
import { Play } from 'lucide-react-native'
import { colors, pressedStyle, spacing } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { styles as chatStyles } from '../mobile-native-chat-view-styles'

// The chat's small secondary action, as its Try Again on earlier messages.
export function MobileNativeChatInterruptedContinueButton({
  onPress
}: {
  onPress: () => void
}): React.JSX.Element {
  const t = useMobileTranslation()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={t(
        'chat.interruptedContinue.explanation',
        'Continue, and the agent first checks whether its last step finished.'
      )}
      onPress={onPress}
      style={({ pressed }) => [chatStyles.retryPill, styles.button, pressed && pressedStyle]}
    >
      <Play size={14} color={colors.textSecondary} />
      <Text style={chatStyles.retryPillLabel}>{t('common.continue', 'Continue')}</Text>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  button: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm
  }
}))
