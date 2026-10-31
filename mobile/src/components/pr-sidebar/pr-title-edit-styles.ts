import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'

export const prTitleEditStyles = themedStyleSheet(() => ({
  container: {
    // Field → Cancel/Save needs clear separation.
    gap: spacing.md
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm
  },
  cancel: {
    minHeight: 36,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control
  },
  cancelText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  submit: {
    minHeight: 36,
    minWidth: 72,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control,
    backgroundColor: colors.textPrimary
  },
  submitText: {
    color: colors.bgBase,
    fontSize: typography.metaSize,
    fontWeight: '700'
  },
  pressed: {
    opacity: 0.8
  },
  error: {
    color: colors.statusRed,
    fontSize: typography.metaSize
  }
}))
