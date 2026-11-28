import { StyleSheet } from 'react-native'
import { radii, spacing, typography } from '../theme/mobile-theme'
import { WORKTREE_ROW_LAYOUT } from '../worktree/row-presentation/worktree-list-row-layout'
import { themedStyleSheet } from '../theme/themed-styles'

export const hostScreenSecondaryStylesSheet = themedStyleSheet((colors) => ({
  list: {
    paddingBottom: spacing.lg
  },
  // The chevron sits in the rows' status-dot column, so the icon and title start at the row text.
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: WORKTREE_ROW_LAYOUT.indicatorInset,
    paddingRight: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: 6
  },
  sectionChevron: {
    width: WORKTREE_ROW_LAYOUT.indicatorWidth,
    alignItems: 'center',
    marginRight: spacing.sm
  },
  sectionIcon: {
    marginRight: spacing.xs
  },
  sectionRepoIcon: {
    marginRight: spacing.xs
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
    flexShrink: 1
  },
  sectionCount: {
    fontSize: 13,
    color: colors.textMuted,
    marginLeft: 6
  },
  // Muted and plain, like the header's count: a fact about the section, not an action.
  sectionPendingSpinner: {
    marginLeft: spacing.sm
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginLeft: WORKTREE_ROW_LAYOUT.textInset
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
