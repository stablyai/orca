import { StyleSheet } from 'react-native'
import { colors, radii, spacing, textStyles, typography } from '../theme/mobile-theme'
import { LIST_LEADING_INSET, LIST_ROW_PADDING } from '../components/ui/ListGroup'

// The plain changed-files list, its section headers, the commit bar and the commit failure notice.
export const listStyles = StyleSheet.create({
  emptyState: {
    flex: 1
  },
  sectionActions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: -spacing.md,
    marginRight: -spacing.md
  },
  sectionSubtitle: {
    ...textStyles.footnote,
    color: colors.textMuted,
    paddingHorizontal: spacing.lg + 4,
    marginTop: -spacing.xs,
    paddingBottom: spacing.sm
  },
  branchStateRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: LIST_ROW_PADDING
  },
  branchStateText: {
    ...textStyles.callout,
    flex: 1,
    color: colors.textSecondary
  },
  rowSeparator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: LIST_LEADING_INSET,
    backgroundColor: colors.separator
  },
  fileRow: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingLeft: LIST_ROW_PADDING,
    paddingRight: spacing.md,
    paddingVertical: spacing.sm
  },
  fileRowPressed: {
    backgroundColor: colors.fill
  },
  statusSlot: {
    width: 28,
    alignItems: 'center'
  },
  statusLetter: {
    fontFamily: typography.monoFamily,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '600'
  },
  fileTextBlock: {
    flex: 1,
    minWidth: 0,
    gap: 1
  },
  fileName: {
    ...textStyles.body,
    color: colors.textPrimary
  },
  fileNameUnavailable: {
    color: colors.textSecondary
  },
  fileDetail: {
    ...textStyles.footnote,
    color: colors.textMuted
  },
  fileDetailWarning: {
    color: colors.statusAmber
  },
  rowSpinner: {
    width: 44,
    alignItems: 'center'
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  commitBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm + 2,
    backgroundColor: colors.bgBase,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator
  },
  commitIdleRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingLeft: spacing.sm
  },
  commitIdleText: {
    ...textStyles.callout,
    flex: 1,
    color: colors.textMuted
  },
  // The 44 pt touch boxes overhang the reply box's own padding, as its round send does.
  commitTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginVertical: -4
  },
  commitFailurePanel: {
    marginHorizontal: spacing.lg,
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.group,
    backgroundColor: 'rgba(255, 107, 107, 0.1)'
  },
  commitFailureHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md
  },
  commitFailureTextBlock: {
    flex: 1,
    minWidth: 0,
    gap: 2
  },
  commitFailureTitle: {
    ...textStyles.callout,
    fontWeight: '600',
    color: colors.textPrimary
  },
  commitFailureSummary: {
    ...textStyles.callout,
    color: colors.textSecondary
  },
  commitFailureActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: 30
  },
  commitFailureDetailsText: {
    fontFamily: typography.monoFamily,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textSecondary,
    paddingLeft: 30
  },
  commitFailureLaunchError: {
    ...textStyles.footnote,
    color: colors.danger
  }
})
