import {
  StyleSheet,
  Platform,
  colors,
  radii,
  spacing,
  typography
} from './mobile-tasks-dependencies'

export const mobileTasksComposerActionStyles = StyleSheet.create({
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
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2
  },
  targetButtonText: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  issueSourceBox: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel,
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
    borderRadius: radii.input,
    backgroundColor: colors.bgBase,
    padding: 2,
    gap: 2
  },
  issueSourceSegmentButton: {
    flex: 1,
    borderRadius: radii.input - 2,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  issueSourceSegmentButtonActive: {
    backgroundColor: colors.bgRaised
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
  input: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  bodyInput: {
    minHeight: 88
  },
  monoInput: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })
  },
  commentInput: {
    minHeight: 72,
    marginTop: spacing.sm
  },
  commentComposer: {
    position: 'relative',
    marginTop: spacing.sm
  },
  commentComposerInput: {
    minHeight: 40,
    maxHeight: 120,
    marginTop: 0,
    paddingRight: 44
  },
  commentComposerSend: {
    position: 'absolute',
    right: spacing.xs,
    bottom: spacing.xs,
    width: 32,
    height: 32,
    borderRadius: radii.button,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  commentComposerSendPressed: {
    opacity: 0.75
  },
  commentComposerSendDisabled: {
    opacity: 0.5
  },
  replyInput: {
    minHeight: 48,
    marginTop: spacing.xs
  },
  stackedInput: {
    marginTop: spacing.sm
  },
  inlineSaveButton: {
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
    borderRadius: radii.button,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs
  },
  inlineSaveButtonCompact: {
    alignSelf: 'flex-start',
    borderRadius: radii.button,
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
    borderRadius: radii.button,
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
    borderRadius: radii.button,
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
    borderRadius: radii.button,
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
})
