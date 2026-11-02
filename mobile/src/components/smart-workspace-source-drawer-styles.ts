import { StyleSheet } from 'react-native'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { LIST_LEADING_INSET, LIST_ROW_PADDING } from './list/ListGroup'

export const smartWorkspaceSourceDrawerStyles = themedStyleSheet(() => ({
  root: {
    flex: 1,
    minHeight: 0
  },
  header: {
    marginTop: -spacing.xs,
    marginBottom: spacing.xs,
    flexShrink: 0
  },
  results: {
    flex: 1,
    minHeight: 0
  },
  list: {
    flex: 1,
    marginBottom: spacing.sm,
    backgroundColor: colors.sheetGroup,
    borderRadius: radii.surface,
    overflow: 'hidden'
  },
  // With no rows the footer's message stands alone on the sheet, not in an empty group.
  listEmpty: {
    backgroundColor: 'transparent'
  },
  listContent: {
    flexGrow: 1
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginLeft: LIST_LEADING_INSET
  },
  // Pin dock to fill sheet bottom so flex-greedy FlatList cannot push TextInput below frame/keyboard.
  dock: {
    flexShrink: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.sheetSurface,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
    zIndex: 2
  },
  tabRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  tabSelected: {
    backgroundColor: colors.sheetGroup,
    borderColor: colors.textSecondary
  },
  tabText: {
    fontSize: 13,
    color: colors.textSecondary
  },
  tabTextSelected: {
    color: colors.textPrimary,
    fontWeight: '600'
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  chipSelected: {
    backgroundColor: colors.sheetGroup,
    borderColor: colors.textSecondary
  },
  chipText: {
    fontSize: 12,
    color: colors.textSecondary
  },
  chipTextSelected: {
    color: colors.textPrimary,
    fontWeight: '600'
  },
  crossRepo: {
    backgroundColor: colors.sheetGroup,
    borderRadius: radii.surface,
    paddingHorizontal: LIST_ROW_PADDING,
    paddingVertical: spacing.md,
    marginBottom: spacing.sm,
    gap: spacing.sm
  },
  crossRepoText: {
    fontSize: 13,
    color: colors.textSecondary
  },
  crossRepoActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm
  },
  crossRepoDismiss: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  crossRepoDismissText: {
    fontSize: 13,
    color: colors.textSecondary
  },
  crossRepoSwitch: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radii.control,
    backgroundColor: colors.textPrimary
  },
  crossRepoSwitchText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.bgBase
  },
  notice: {
    fontSize: 13,
    color: colors.textSecondary,
    paddingHorizontal: LIST_ROW_PADDING,
    paddingBottom: spacing.sm
  },
  errorNotice: {
    fontSize: 13,
    color: colors.statusRed,
    paddingHorizontal: LIST_ROW_PADDING,
    paddingBottom: spacing.sm
  },
  loading: {
    paddingVertical: spacing.lg,
    alignItems: 'center'
  },
  empty: {
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl,
    textAlign: 'center',
    color: colors.textSecondary,
    fontSize: 13
  }
}))
