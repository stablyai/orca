import { StyleSheet, colors, radii, spacing, textStyles } from './mobile-tasks-dependencies'

export const mobileTasksWorkspaceReviewStyles = StyleSheet.create({
  workspaceCreateForm: {
    gap: 0
  },
  workspaceCreateField: {
    marginBottom: spacing.md
  },
  workspaceCreateLabel: {
    ...textStyles.footnote,
    fontWeight: '500',
    color: colors.textSecondary,
    paddingLeft: 4,
    marginBottom: spacing.sm
  },
  workspaceCreateLabelHint: {
    fontWeight: '400',
    color: colors.textMuted
  },
  workspaceAdvancedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    marginBottom: spacing.xs
  },
  workspaceAdvancedText: {
    ...textStyles.subhead,
    fontWeight: '500',
    color: colors.textSecondary
  },
  workspaceCreateActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: spacing.sm
  },
  workspaceCreateButton: {
    minWidth: 160,
    paddingHorizontal: spacing.lg
  },
  sshConnectCard: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.group,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.xs
  },
  sshStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  sshStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 999
  },
  sshStatusDotConnected: {
    backgroundColor: colors.statusGreen
  },
  sshStatusDotProgress: {
    backgroundColor: colors.statusAmber
  },
  sshStatusDotDisconnected: {
    backgroundColor: colors.statusRed
  },
  sshStatusCopy: {
    flex: 1,
    minWidth: 0
  },
  sshStatusTitle: {
    ...textStyles.body,
    fontWeight: '500',
    color: colors.textPrimary
  },
  reviewerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.separator,
    borderRadius: radii.card,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  reviewerAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  reviewerAvatarText: {
    ...textStyles.caption,
    fontWeight: '700',
    color: colors.textSecondary
  },
  reviewerInfo: {
    flex: 1,
    minWidth: 0
  },
  reviewerName: {
    ...textStyles.footnote,
    fontWeight: '600',
    color: colors.textPrimary
  },
  reviewerMeta: {
    ...textStyles.caption,
    color: colors.textMuted
  },
  reviewerState: {
    flexShrink: 0,
    ...textStyles.caption,
    color: colors.textSecondary
  },
  projectFieldCard: {
    borderWidth: 1,
    borderColor: colors.separator,
    borderRadius: radii.card,
    padding: spacing.sm,
    gap: spacing.xs
  },
  projectFieldName: {
    flex: 1,
    minWidth: 0,
    ...textStyles.footnote,
    fontWeight: '600',
    color: colors.textPrimary
  },
  projectFieldValue: {
    maxWidth: 140,
    ...textStyles.footnote,
    color: colors.textMuted
  },
  projectIterationList: {
    gap: spacing.xs
  },
  projectIterationCopy: {
    flex: 1,
    minWidth: 0,
    gap: 2
  },
  detailLine: {
    ...textStyles.subhead,
    color: colors.textSecondary
  },
  fileActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: 2
  },
  fileCard: {
    borderWidth: 1,
    borderColor: colors.separator,
    borderRadius: radii.card,
    padding: spacing.sm,
    gap: spacing.xs
  },
  pipelineStatusChip: {
    flexShrink: 0,
    borderWidth: 1,
    borderColor: colors.separator,
    borderRadius: 999,
    backgroundColor: colors.bgRaised,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2
  },
  pipelineStatusSuccess: {
    borderColor: colors.statusGreen
  },
  pipelineStatusWarning: {
    borderColor: colors.statusAmber
  },
  pipelineStatusDanger: {
    borderColor: colors.statusRed
  },
  pipelineStatusActive: {
    borderColor: colors.accentBlue
  },
  pipelineStatusText: {
    ...textStyles.caption,
    fontWeight: '500',
    color: colors.textSecondary
  }
})
