import { StyleSheet } from 'react-native'
import { colors, MIN_TOUCH_TARGET, spacing, textStyles } from '../theme/mobile-theme'

/** Indent per tree level: deep folders keep room for their names on a phone. */
export const FILE_TREE_INDENT = 12
export const FILE_TREE_ROW_PADDING = spacing.lg

export const fileExplorerStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  header: {
    backgroundColor: colors.bgBase
  },
  filter: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm
  },
  list: { flex: 1 },
  listContent: {
    paddingBottom: spacing.xl
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: FILE_TREE_ROW_PADDING,
    backgroundColor: colors.separator
  },
  row: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingRight: FILE_TREE_ROW_PADDING
  },
  rowPressed: {
    backgroundColor: colors.fill
  },
  rowDisabled: {
    opacity: 0.55
  },
  chevronBox: {
    width: 16,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  },
  chevronCollapsed: { transform: [{ rotate: '0deg' }] },
  chevronExpanded: { transform: [{ rotate: '90deg' }] },
  icon: { flexShrink: 0 },
  rowTitle: {
    ...textStyles.body,
    flex: 1,
    minWidth: 0,
    color: colors.textPrimary
  },
  rowTitleDisabled: {
    color: colors.textMuted
  },
  rowTrailing: {
    ...textStyles.footnote,
    flexShrink: 0,
    color: colors.textMuted
  },
  inlineStatusRow: {
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingRight: spacing.sm
  },
  inlineStatusText: {
    ...textStyles.footnote,
    color: colors.textSecondary
  },
  inlineErrorText: {
    ...textStyles.footnote,
    flex: 1,
    minWidth: 0,
    color: colors.danger
  }
})
