import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { WORKTREE_ROW_LAYOUT } from '../components/worktree-list-row-layout'
import { themedStyleSheet } from '../theme/themed-styles'

export const hostScreenSecondaryStyles = themedStyleSheet(() => ({
  errorText: {
    color: colors.statusRed,
    fontSize: typography.bodySize
  },
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
  sectionPendingSpinner: {
    marginLeft: spacing.sm
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginLeft: WORKTREE_ROW_LAYOUT.textInset
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
  // Over the sheet header's empty leading side, centred in its 52pt row.
  optionPageBack: {
    position: 'absolute',
    top: 8,
    left: spacing.xs
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
