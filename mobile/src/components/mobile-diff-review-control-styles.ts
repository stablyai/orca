import { StyleSheet } from 'react-native'
import { colors, feedback, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const mobileDiffReviewControlStyles = themedStyleSheet(() => ({
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    gap: spacing.sm,
    backgroundColor: colors.bgBase,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  // Sized like SheetPrimaryButton so the bar matches every other bottom action.
  navButton: {
    width: 48,
    height: 48,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  primaryButton: {
    flex: 1,
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.control,
    backgroundColor: colors.textPrimary
  },
  primaryButtonText: {
    color: colors.bgBase,
    fontSize: 15,
    fontWeight: '600'
  },
  secondaryButton: {
    flex: 1,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised
  },
  sheetSecondaryButton: {
    backgroundColor: colors.sheetGroup
  },
  secondaryButtonText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  destructiveText: {
    color: colors.statusRed,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  buttonPressed: {
    opacity: feedback.pressedOpacity
  },
  buttonDisabled: {
    opacity: feedback.disabledOpacity
  },
  composerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.md
  },
  drawerTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '600'
  },
  drawerSubtitle: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    marginTop: 2
  },
  rangeField: {
    minHeight: 96,
    alignItems: 'flex-start'
  },
  rangeError: {
    marginTop: spacing.sm,
    color: colors.statusRed,
    fontSize: typography.metaSize
  },
  drawerButtonRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md
  }
}))
