import { StyleSheet, colors, radii, spacing, typography } from './mobile-tasks-dependencies'

export const mobileTasksDiffCommentStyles = StyleSheet.create({
  filePreview: {
    gap: spacing.xs,
    marginTop: spacing.xs
  },
  fileDiff: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.row,
    overflow: 'hidden'
  },
  diffLineBlock: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    borderLeftWidth: 2,
    borderLeftColor: colors.borderSubtle,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xs,
    gap: spacing.xs
  },
  diffLineAdded: {
    borderLeftColor: colors.statusGreen
  },
  diffLineRemoved: {
    borderLeftColor: colors.statusRed
  },
  diffCodeRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    alignItems: 'flex-start'
  },
  diffLineNumbers: {
    width: 76,
    flexShrink: 0,
    fontFamily: typography.monoFamily,
    fontSize: 10,
    lineHeight: 16,
    color: colors.textMuted
  },
  codeLine: {
    flex: 1,
    fontFamily: typography.monoFamily,
    fontSize: 11,
    lineHeight: 16,
    color: colors.textSecondary
  },
  diffCodeAdded: {
    color: colors.statusGreen
  },
  diffCodeRemoved: {
    color: colors.statusRed
  },
  detailMuted: {
    fontSize: 12,
    color: colors.textSecondary
  },
  commentBlock: {
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    paddingTop: spacing.sm
  },
  commentThreadGroup: {
    gap: spacing.xs
  },
  commentReplyBlock: {
    marginLeft: spacing.md,
    paddingLeft: spacing.sm,
    borderLeftWidth: 1,
    borderLeftColor: colors.borderSubtle
  },
  commentResolvedBlock: {
    opacity: 0.6
  },
  resolvedCommentSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm
  },
  resolvedCommentTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    color: colors.textSecondary
  },
  commentSource: {
    fontSize: 11,
    lineHeight: 15,
    color: colors.textSecondary,
    marginBottom: 2
  },
  commentMeta: {
    fontSize: 11,
    color: colors.textMuted,
    marginBottom: 2
  },
  commentControls: {
    gap: spacing.xs,
    marginTop: spacing.sm
  },
  reactionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs
  },
  reactionChip: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2
  },
  reactionText: {
    fontSize: 11,
    color: colors.textSecondary
  },
  inlineActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: spacing.md
  },
  actionText: {
    flex: 1,
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  actionSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  setupPromptBox: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.xs
  },
  setupPromptCommand: {
    fontFamily: typography.monoFamily,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textPrimary
  },
  linearStatesBlock: {
    paddingTop: spacing.sm
  },
  linearStatesTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: spacing.md + 2,
    paddingBottom: spacing.xs
  },
  emptyInlineText: {
    color: colors.textSecondary,
    fontSize: 13,
    paddingHorizontal: spacing.md + 2,
    paddingBottom: spacing.md
  }
})
