import {
  StyleSheet,
  colors,
  radii,
  spacing,
  textStyles,
  typography
} from './mobile-tasks-dependencies'

export const mobileTasksDiffCommentStyles = StyleSheet.create({
  filePreview: {
    gap: spacing.xs,
    marginTop: spacing.xs
  },
  fileDiff: {
    borderWidth: 1,
    borderColor: colors.separator,
    borderRadius: radii.row,
    overflow: 'hidden'
  },
  diffLineBlock: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
    borderLeftWidth: 2,
    borderLeftColor: colors.separator,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xs,
    gap: spacing.xs
  },
  diffLineAdded: {
    borderLeftColor: colors.diffAddedGutter,
    backgroundColor: colors.diffAddedBg
  },
  diffLineRemoved: {
    borderLeftColor: colors.diffDeletedGutter,
    backgroundColor: colors.diffDeletedBg
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
    fontSize: 12,
    lineHeight: 19,
    color: colors.textMuted
  },
  codeLine: {
    flex: 1,
    fontFamily: typography.monoFamily,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textSecondary
  },
  diffCodeAdded: {
    color: colors.chatDiffAdded
  },
  diffCodeRemoved: {
    color: colors.chatDiffRemoved
  },
  detailMuted: {
    ...textStyles.footnote,
    color: colors.textSecondary
  },
  commentBlock: {
    gap: 2,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator
  },
  commentThreadGroup: {
    gap: spacing.sm
  },
  commentReplyBlock: {
    marginLeft: spacing.md,
    paddingLeft: spacing.md,
    borderTopWidth: 0,
    borderLeftWidth: 2,
    borderLeftColor: colors.separator
  },
  commentResolvedBlock: {
    opacity: 0.6
  },
  resolvedCommentSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    borderRadius: radii.field,
    backgroundColor: colors.fill,
    paddingHorizontal: spacing.md
  },
  resolvedCommentSummaryPressed: {
    backgroundColor: colors.fillPressed
  },
  resolvedCommentTitle: {
    ...textStyles.footnote,
    flex: 1,
    minWidth: 0,
    color: colors.textSecondary
  },
  resolvedCommentAction: {
    ...textStyles.footnote,
    fontWeight: '500',
    color: colors.textPrimary
  },
  commentSource: {
    ...textStyles.caption,
    color: colors.textMuted
  },
  commentMeta: {
    ...textStyles.footnote,
    fontWeight: '500',
    color: colors.textSecondary,
    marginBottom: 2
  },
  commentControls: {
    gap: spacing.xs,
    marginTop: spacing.sm
  },
  reactionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: spacing.xs
  },
  reactionChip: {
    height: 26,
    justifyContent: 'center',
    backgroundColor: colors.fill,
    borderRadius: radii.pill,
    paddingHorizontal: 10
  },
  reactionText: {
    ...textStyles.footnote,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums']
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
    gap: spacing.md,
    minHeight: 52,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm
  },
  actionText: {
    ...textStyles.body,
    flex: 1,
    color: colors.textPrimary
  },
  actionSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.separator,
    marginLeft: spacing.lg
  },
  setupPromptBox: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.group,
    padding: spacing.lg,
    marginHorizontal: spacing.xs,
    marginBottom: spacing.lg,
    gap: spacing.sm
  },
  setupPromptCommand: {
    fontFamily: typography.monoFamily,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textPrimary
  },
  linearStatesBlock: {
    paddingTop: spacing.sm
  },
  linearStatesTitle: {
    ...textStyles.footnote,
    fontWeight: '500',
    color: colors.textMuted,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs
  },
  emptyInlineText: {
    ...textStyles.callout,
    color: colors.textSecondary,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md
  }
})
