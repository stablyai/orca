import { Pressable, Text } from 'react-native'
import { Goal, X } from 'lucide-react-native'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import {
  COMPOSER_CONTROL_HIT_SLOP,
  COMPOSER_CONTROL_SIZE,
  composerInputStyles
} from '../../../components/composer-input/composer-input-styles'

/** Goal mode's chip: a tap leaves the mode, it never clears the chat's goal. Touch has no hover, so the × always shows. */
export function MobileNativeChatComposerGoalChip({
  onExit
}: {
  onExit: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('chat.goal.exitMode', 'Exit goal mode')}
      hitSlop={COMPOSER_CONTROL_HIT_SLOP}
      style={({ pressed }) => [styles.chip, pressed && composerInputStyles.pressed]}
      onPress={onExit}
      testID="native-chat-goal-chip"
    >
      <Goal size={15} color={colors.textPrimary} strokeWidth={2} />
      <Text style={styles.label}>{t('chat.goal.chip', 'Goal')}</Text>
      <X size={14} color={colors.textMuted} strokeWidth={2} />
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  chip: {
    height: COMPOSER_CONTROL_SIZE,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.translucentFill,
    flexShrink: 0
  },
  label: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  }
}))
