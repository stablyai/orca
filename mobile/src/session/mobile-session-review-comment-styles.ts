import { StyleSheet } from 'react-native'

import { colors, spacing, radii, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const mobileSessionReviewCommentStyles = themedStyleSheet(() => ({
  diffCommentAddButton: {
    width: 26,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control
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
    borderRadius: radii.surface,
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
    borderRadius: radii.control
  },
  diffCommentBody: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    lineHeight: 17
  },
  diffCommentComposer: {
    marginLeft: 44,
    marginRight: spacing.sm,
    marginTop: spacing.xs
  },
  markdownButtonDisabled: {
    opacity: 0.45
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
    borderRadius: radii.pill,
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
    borderRadius: radii.control,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs
  },
  markdownCopyButton: {
    backgroundColor: colors.bgRaised,
    borderWidth: 0
  },
  markdownKeyboardDismissButton: {
    width: 34,
    justifyContent: 'center',
    paddingHorizontal: 0
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
    borderRadius: radii.surface,
    overflow: 'hidden'
  }
}))
