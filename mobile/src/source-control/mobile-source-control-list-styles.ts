import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

// Changed-files list, section headers, file rows, and the commit bar. Split
// from the main source-control stylesheet to stay under the line limit.
export const listStyles = StyleSheet.create({
  listContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: 136
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: spacing.md,
    paddingBottom: spacing.xs
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase'
  },
  sectionCount: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  branchCompareBlock: {
    paddingBottom: spacing.sm
  },
  branchSectionTitleBlock: {
    flex: 1,
    minWidth: 0
  },
  branchSectionSubtitle: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    marginTop: 2
  },
  branchStateRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  branchStateText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    lineHeight: 18
  },
  fileRow: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  fileRowPressed: {
    backgroundColor: colors.bgPanel
  },
  fileRowDisabled: {
    opacity: 0.78
  },
  fileRowUnavailable: {
    opacity: 0.72
  },
  statusBadge: {
    width: 24,
    alignItems: 'center'
  },
  statusBadgeText: {
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    fontWeight: '700'
  },
  fileTextBlock: {
    flex: 1,
    minWidth: 0
  },
  filePath: {
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  filePathDisabled: {
    color: colors.textSecondary
  },
  fileMeta: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    marginTop: 2
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  iconButton: {
    width: 32,
    height: 32,
    borderRadius: radii.button,
    alignItems: 'center',
    justifyContent: 'center'
  },
  iconButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  iconButtonDisabled: {
    opacity: 0.45
  },
  commitBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    gap: spacing.xs,
    padding: spacing.lg,
    paddingTop: spacing.md,
    backgroundColor: colors.bgPanel,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  commitRow: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  commitInput: {
    flex: 1,
    minHeight: 42,
    borderRadius: radii.input,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgBase,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    fontSize: typography.bodySize
  },
  commitInputDisabled: {
    backgroundColor: colors.bgPanel,
    borderColor: colors.borderSubtle,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center'
  },
  commitInputDisabledText: {
    color: colors.textMuted,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  commitButton: {
    minWidth: 88,
    minHeight: 42,
    borderRadius: radii.button,
    backgroundColor: colors.textPrimary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md
  },
  generateButton: {
    width: 42,
    minHeight: 42,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  commitButtonDisabled: {
    opacity: 0.45
  },
  commitButtonPressed: {
    opacity: 0.75
  },
  commitButtonText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '700'
  }
})
