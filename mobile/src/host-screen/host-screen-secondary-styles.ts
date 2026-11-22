import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { WORKTREE_ROW_LAYOUT } from '../worktree/row-presentation/worktree-list-row-layout'
import { themedStyleSheet } from '../theme/themed-styles'

export const hostScreenSecondaryStyles = themedStyleSheet(() => ({
  errorText: {
    color: colors.statusRed,
    fontSize: typography.bodySize
  },
  list: {
    paddingBottom: spacing.lg
  },
  offlineBanner: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm
  },
  // A project's line: inset like the rows' text column, ruled off from the rows under it.
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    marginTop: spacing.xl - spacing.xxs,
    marginHorizontal: WORKTREE_ROW_LAYOUT.indicatorInset,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  sectionHeaderFirst: {
    marginTop: spacing.xs
  },
  sectionTitle: {
    flexShrink: 1,
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary
  },
  sectionCount: {
    flexShrink: 0,
    fontSize: 15,
    fontWeight: '500',
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  },
  sectionSpacer: {
    flex: 1
  },
  // Muted and plain, like the header's count: a fact about the section, not an action.
  sectionPendingSpinner: {
    marginLeft: spacing.xs
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginLeft: WORKTREE_ROW_LAYOUT.textInset,
    marginRight: WORKTREE_ROW_LAYOUT.indicatorInset
  },
  filterModalSubtitle: {
    fontSize: typography.metaSize,
    color: colors.textMuted
  },
  optionPending: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    marginBottom: spacing.sm
  },
  optionSectionGap: {
    height: spacing.xs
  },
  optionGroup: {
    marginBottom: spacing.md
  },
  optionSearch: {
    marginBottom: spacing.sm
  },
  optionSegmented: {
    marginBottom: spacing.md
  },
  filterRepoDot: {
    width: 8,
    height: 8,
    borderRadius: radii.pill
  },
  confirmContent: {
    paddingBottom: spacing.lg
  },
  confirmTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary
  },
  confirmMessage: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    lineHeight: 20
  },
  // Desktop's amber loss line, as plain text: what deleting throws away.
  confirmLoss: {
    color: colors.statusAmber
  },
  confirmDetail: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    marginTop: spacing.xs,
    lineHeight: 16
  },
  confirmButtons: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  confirmBtn: {
    flex: 1,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.control,
    alignItems: 'center'
  },
  confirmBtnCancel: {
    backgroundColor: colors.sheetGroup
  },
  confirmBtnDestructive: {
    backgroundColor: colors.statusRed
  },
  confirmBtnPressed: {
    opacity: 0.7
  },
  confirmBtnCancelText: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.textSecondary
  },
  confirmBtnDestructiveText: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: '#fff'
  }
}))
