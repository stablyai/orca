import { StyleSheet, colors, radii, spacing, typography } from './mobile-tasks-dependencies'

export const mobileTasksWorkspaceReviewStyles = StyleSheet.create({
  workspaceCreateForm: {
    gap: 0
  },
  workspaceCreateField: {
    marginBottom: spacing.md
  },
  workspaceCreateLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
    marginBottom: spacing.xs
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
    fontSize: typography.bodySize,
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
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
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
    fontSize: typography.bodySize,
    color: colors.textPrimary,
    fontWeight: '600'
  },
  reviewerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
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
    fontSize: 11,
    fontWeight: '700',
    color: colors.textSecondary
  },
  reviewerInfo: {
    flex: 1,
    minWidth: 0
  },
  reviewerName: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textPrimary
  },
  reviewerMeta: {
    fontSize: 11,
    color: colors.textMuted
  },
  reviewerState: {
    flexShrink: 0,
    fontSize: 11,
    color: colors.textSecondary
  },
  projectFieldCard: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    padding: spacing.sm,
    gap: spacing.xs
  },
  projectFieldName: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    fontWeight: '600',
    color: colors.textPrimary
  },
  projectFieldValue: {
    maxWidth: 140,
    fontSize: 12,
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
    fontSize: 12,
    lineHeight: 17,
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
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    padding: spacing.sm,
    gap: spacing.xs
  },
  pipelineStatusChip: {
    flexShrink: 0,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
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
    fontSize: 10,
    color: colors.textSecondary,
    fontWeight: '600',
    textTransform: 'uppercase'
  }
})
