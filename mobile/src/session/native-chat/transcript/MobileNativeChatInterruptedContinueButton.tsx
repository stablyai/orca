import { Pressable, StyleSheet, Text } from 'react-native'
import { Play } from 'lucide-react-native'
import { colors, pressedStyle, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'

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
      style={({ pressed }) => [styles.button, pressed && pressedStyle]}
    >
      <Play size={14} color={colors.textSecondary} />
      <Text style={styles.label}>{t('chat.interruptedContinue.continue', 'Continue')}</Text>
    </Pressable>
  )
}

// The chat's small secondary action, as its Try Again on earlier messages.
const styles = themedStyleSheet(() => ({
  button: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    alignItems: 'center',
    gap: spacing.xs,
    height: 28,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  label: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  }
}))
