import { themedStyleSheet } from '../theme/themed-styles'
import { colors, spacing, typography } from '../theme/mobile-theme'

// Only what the option rows lack; rows, groups and labels are in mobile-bot-option-styles.
export const sheetStyles = themedStyleSheet(() => ({
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexShrink: 1
  },
  dotSlot: {
    width: 16,
    alignItems: 'center'
  },
  textButton: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.xs
  },
  textButtonLabel: {
    fontSize: typography.metaSize,
    color: colors.textSecondary
  },
  // Monochrome emphasis: red is kept for destructive confirms.
  alert: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textSecondary,
    marginTop: 2
  },
  empty: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    textAlign: 'center',
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md
  }
}))
