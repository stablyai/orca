import { themedStyleSheet } from '../theme/themed-styles'
import { colors, feedback, spacing } from '../theme/mobile-theme'

// Only what the option rows lack; rows, groups and labels are in mobile-bot-option-styles.
export const sheetStyles = themedStyleSheet(() => ({
  textButton: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs
  },
  textButtonDisabled: { opacity: feedback.disabledOpacity },
  textButtonLabel: {
    fontSize: 13,
    color: colors.textSecondary
  },
  textButtonAccent: { fontWeight: '500', color: colors.accentBlue }
}))
