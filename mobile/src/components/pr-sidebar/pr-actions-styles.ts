import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'

export const prActionsStyles = StyleSheet.create({
  actionsBlock: {
    gap: spacing.sm
  },
  // Close/Reopen + Unlink share a row so secondary actions don't stack full-width.
  secondaryRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: spacing.sm
  },
  secondaryButton: {
    flex: 1
  },
  actionButton: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  // Use neutral light/dark primary like desktop so sidebar stays mostly monochrome.
  actionButtonPrimary: {
    backgroundColor: colors.textPrimary,
    borderColor: colors.textPrimary
  },
  // Match desktop affirmative green merge CTA; action still confirms before execution.
  actionButtonMerge: {
    backgroundColor: colors.mergeGreen,
    borderColor: colors.mergeGreen
  },
  actionButtonTextMerge: {
    color: colors.onMergeGreen
  },
  actionButtonDisabled: {
    opacity: 0.5
  },
  actionButtonText: {
    // Shrink single-line labels so long Link existing pull request cannot wrap and inflate narrow button height.
    flexShrink: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  actionButtonTextPrimary: {
    color: colors.bgBase
  },
  actionButtonDestructiveText: {
    color: colors.statusRed
  },
  toggleRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  toggleLabel: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    flexShrink: 1
  },
  togglePill: {
    minWidth: 56,
    minHeight: 30,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  togglePillOn: {
    borderColor: colors.textSecondary,
    backgroundColor: colors.bgRaised
  },
  togglePillText: {
    fontSize: typography.metaSize,
    fontWeight: '700',
    color: colors.textSecondary
  },
  togglePillTextOn: {
    color: colors.textPrimary
  },
  actionError: {
    color: colors.statusRed,
    fontSize: typography.metaSize,
    lineHeight: 18
  }
})
