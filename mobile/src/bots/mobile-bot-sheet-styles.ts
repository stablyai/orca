import { themedStyleSheet } from '../theme/themed-styles'
import { feedback, spacing } from '../theme/mobile-theme'

// Only what the option rows lack; rows, groups and labels are in mobile-bot-option-styles.
export const sheetStylesSheet = themedStyleSheet((colors) => ({
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
