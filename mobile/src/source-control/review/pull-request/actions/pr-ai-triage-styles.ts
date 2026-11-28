import { StyleSheet } from 'react-native'
import { radii, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'

export const prAiTriageStylesSheet = themedStyleSheet((colors) => ({
  triageArea: {
    gap: spacing.xs
  },
  triageButton: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised
  },
  triageButtonPressed: {
    opacity: 0.7
  },
  triageButtonText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  triageError: {
    color: colors.statusRed,
    fontSize: typography.metaSize
  }
}))
