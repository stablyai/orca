import { concentricRadius } from '../theme/mobile-theme'
import { themedStyleSheet, colors, radii, spacing, typography } from './mobile-tasks-dependencies'

export const mobileTasksComposerActionStyles = themedStyleSheet(() => ({
  createForm: {
    gap: spacing.sm
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary
  },
  inlineTextLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    alignSelf: 'flex-start',
    paddingVertical: spacing.xs
  },
  inlineTextLinkText: {
    color: colors.textSecondary,
    fontSize: 12,
    textDecorationLine: 'underline'
  },
  securityHintRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs
  },
  securityHintText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 16
  },
  targetButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel,
    borderRadius: radii.control,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2
  },
  targetButtonOnSheet: {
    backgroundColor: colors.sheetGroup
  },
  targetButtonText: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  issueSourceBox: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.surface,
    backgroundColor: colors.sheetGroup,
    padding: spacing.sm,
    gap: spacing.xs
  },
  issueSourceHint: {
    fontSize: 12,
    color: colors.textSecondary
  },
  issueSourceSegment: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.control,
    backgroundColor: colors.sheetSurface,
    padding: 2,
    gap: 2
  },
  issueSourceSegmentButton: {
    flex: 1,
    borderRadius: concentricRadius(radii.control, 2),
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  issueSourceSegmentButtonActive: {
    backgroundColor: colors.sheetGroup
  },
  issueSourceSegmentText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textMuted
  },
  issueSourceSegmentTextActive: {
    color: colors.textPrimary
  },
  issueSourceSlug: {
    marginTop: 1,
    fontSize: 10,
    color: colors.textMuted
  },
  drawerLoadingRow: {
    paddingVertical: spacing.lg,
    alignItems: 'center'
  },
  stackedInput: {
    marginTop: spacing.sm
  },
  inlineSaveButton: {
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs
  },
  inlineSaveButtonCompact: {
    alignSelf: 'flex-start',
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  inlineSaveText: {
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: '600'
  },
  inlineButtonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs
  },
  drawerActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  secondaryActionButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingVertical: spacing.sm
  },
  secondaryActionText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  primaryActionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    borderRadius: radii.control,
    backgroundColor: colors.textPrimary,
    paddingVertical: spacing.sm
  },
  primaryActionText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  inlineDeleteText: {
    color: colors.statusRed,
    fontSize: 12,
    fontWeight: '600'
  },
  createButton: {
    marginTop: spacing.sm,
    backgroundColor: colors.textPrimary,
    borderRadius: radii.control,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center'
  },
  createButtonDisabled: {
    opacity: 0.5
  },
  createButtonText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '700'
  }
}))
