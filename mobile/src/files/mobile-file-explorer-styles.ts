import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const fileExplorerStyles = themedStyleSheet(() => ({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  header: {
    backgroundColor: colors.bgBase
  },
  list: { flex: 1 },
  listContent: {
    paddingVertical: spacing.sm
  },
  row: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingRight: spacing.md
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  rowDisabled: {
    opacity: 0.58
  },
  chevronSpacer: {
    width: 16
  },
  rowTextBlock: {
    flex: 1,
    minWidth: 0
  },
  rowTitle: {
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  rowTitleDisabled: {
    color: colors.textMuted
  },
  rowMeta: {
    marginTop: 1,
    color: colors.textMuted,
    fontSize: 11
  },
  inlineStatusRow: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingRight: spacing.md
  },
  inlineStatusText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  inlineErrorText: {
    flex: 1,
    minWidth: 0,
    color: colors.statusRed,
    fontSize: typography.metaSize
  },
  inlineRetryButton: {
    minHeight: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md
  },
  inlineRetryText: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  state: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.xl
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    textAlign: 'center'
  },
  stateTitle: {
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    fontWeight: '600'
  },
  clearFilterButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radii.control
  },
  clearFilterText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  }
}))
