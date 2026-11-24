import { colors, feedback, radii, spacing, typography } from '../theme/mobile-theme'
import { WORKTREE_ROW_LAYOUT } from '../worktree/row-presentation/worktree-list-row-layout'
import { themedStyleSheet } from '../theme/themed-styles'

// A 20 pt text line with 7 above and below, Home's heading-to-group gap.
const SECTION_HEADER_TEXT_GAP = 7
const SECTION_HEADER_HEIGHT = 20 + SECTION_HEADER_TEXT_GAP * 2

export const hostScreenSecondaryStyles = themedStyleSheet(() => ({
  errorText: {
    color: colors.statusRed,
    fontSize: typography.bodySize
  },
  list: {
    paddingBottom: spacing.lg
  },
  // A project's heading over its group, as Home's: 20 above the text, 7 below it, text at x 20.
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    height: SECTION_HEADER_HEIGHT,
    marginTop: 20 - SECTION_HEADER_TEXT_GAP,
    marginHorizontal: WORKTREE_ROW_LAYOUT.groupInset,
    paddingLeft: spacing.xs,
    // The chevron ends where the rows' trailing text does.
    paddingRight: 14
  },
  sectionHeaderFirst: {
    marginTop: 0
  },
  sectionToggle: {
    flex: 1,
    minWidth: 0,
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  sectionTogglePressed: {
    opacity: feedback.pressedOpacity
  },
  sectionTitle: {
    flexShrink: 1,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '600',
    color: colors.textPrimary
  },
  sectionCount: {
    flexShrink: 0,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '500',
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  },
  sectionSpacer: {
    flex: 1
  },
  sectionAdd: {
    width: SECTION_HEADER_HEIGHT,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center'
  },
  sectionChevron: {
    alignSelf: 'stretch',
    justifyContent: 'center',
    paddingLeft: spacing.xs
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
