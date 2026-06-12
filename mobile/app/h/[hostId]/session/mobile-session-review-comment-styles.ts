import { StyleSheet } from 'react-native'

import { colors, spacing, radii, typography } from '../../../../src/theme/mobile-theme'

export const mobileSessionReviewCommentStyles = StyleSheet.create({
  diffCommentAddButton: {
    width: 26,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button
  },
  diffCommentAddButtonPressed: {
    backgroundColor: colors.bgPanel
  },
  diffCommentButtonDisabled: {
    opacity: 0.45
  },
  diffCommentList: {
    gap: spacing.xs,
    marginLeft: 44,
    marginRight: spacing.sm,
    marginTop: spacing.xs
  },
  diffCommentCard: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    backgroundColor: colors.bgPanel,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  diffCommentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: 2
  },
  diffCommentMeta: {
    flex: 1,
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  diffCommentDeleteButton: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 11
  },
  diffCommentBody: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    lineHeight: 17
  },
  diffCommentComposer: {
    gap: spacing.xs,
    marginLeft: 44,
    marginRight: spacing.sm,
    marginTop: spacing.xs,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    backgroundColor: colors.bgPanel,
    padding: spacing.sm
  },
  diffCommentInput: {
    minHeight: 70,
    height: 70,
    marginRight: 0,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm
  },
  diffCommentComposerActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.xs
  },
  diffCommentSecondaryAction: {
    minHeight: 30,
    justifyContent: 'center',
    borderRadius: radii.button,
    paddingHorizontal: spacing.md
  },
  diffCommentSecondaryText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  diffCommentPrimaryAction: {
    minHeight: 30,
    justifyContent: 'center',
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    paddingHorizontal: spacing.md
  },
  diffCommentPrimaryText: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '700'
  },
  markdownRefreshButton: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs
  },
  markdownButtonDisabled: {
    opacity: 0.45
  },
  markdownRefreshText: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '600'
  },
  markdownFloatingBar: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    bottom: spacing.lg,
    alignItems: 'flex-end',
    gap: spacing.xs
  },
  markdownFloatingStatus: {
    maxWidth: '100%',
    alignSelf: 'flex-end',
    overflow: 'hidden',
    color: colors.textSecondary,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    fontSize: typography.metaSize
  },
  markdownFloatingActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: spacing.xs
  },
  markdownFloatingButton: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs
  },
  markdownSaveButton: {
    backgroundColor: colors.bgRaised
  },
  markdownFloatingButtonText: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '600'
  },
  toast: {
    position: 'absolute',
    bottom: spacing.lg,
    alignSelf: 'center',
    left: 0,
    right: 0,
    alignItems: 'center'
  },
  toastText: {
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    color: colors.textPrimary,
    fontSize: 13,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.button,
    overflow: 'hidden'
  }
})
