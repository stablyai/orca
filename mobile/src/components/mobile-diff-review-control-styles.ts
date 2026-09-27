import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'

export const mobileDiffReviewControlStyles = StyleSheet.create({
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
  fileActionRow: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  navButton: {
    width: 44,
    minHeight: 44,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  footerButton: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  footerButtonText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  primaryButton: {
    flex: 1,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.button,
    backgroundColor: colors.textPrimary
  },
  primaryButtonDone: {
    backgroundColor: colors.statusGreen
  },
  primaryButtonText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '800'
  },
  secondaryButton: {
    flex: 1,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
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
    opacity: 0.76
  },
  buttonDisabled: {
    opacity: 0.45
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
    fontSize: typography.titleSize,
    fontWeight: '700'
  },
  drawerSubtitle: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    marginTop: 2
  },
  composerInput: {
    minHeight: 112,
    borderRadius: radii.input,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel,
    color: colors.textPrimary,
    // Through the seam, as the commit bar is: 14px focuses into a zoomed page on iOS.
    fontSize: TEXT_INPUT_FONT_SIZE,
    lineHeight: 20,
    padding: spacing.md,
    textAlignVertical: 'top'
  },
  drawerButtonRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md
  }
})
