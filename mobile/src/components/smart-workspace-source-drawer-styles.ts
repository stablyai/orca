import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export const smartWorkspaceSourceDrawerStyles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm,
    flexShrink: 0
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary
  },
  done: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.accentBlue
  },
  results: {
    flex: 1,
    minHeight: 0
  },
  list: {
    flex: 1,
    backgroundColor: colors.bgPanel,
    borderTopLeftRadius: radii.card,
    borderTopRightRadius: radii.card,
    overflow: 'hidden'
  },
  listContent: {
    flexGrow: 1,
    paddingBottom: spacing.sm
  },
  // Why: pin the dock to the sheet bottom so a flex-greedy FlatList cannot
  // push the TextInput out of the fill frame (and under the keyboard).
  dock: {
    flexShrink: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgBase,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
    zIndex: 2
  },
  search: {
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    fontSize: typography.bodySize,
    borderWidth: 1,
    borderColor: colors.borderSubtle
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
    borderRadius: radii.button,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  tabSelected: {
    backgroundColor: colors.bgPanel,
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
    borderRadius: radii.button,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  chipSelected: {
    backgroundColor: colors.bgPanel,
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
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: spacing.md,
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
    borderRadius: radii.button,
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
    borderRadius: radii.button,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.textSecondary
  },
  crossRepoSwitchText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary
  },
  notice: {
    fontSize: 12,
    color: colors.textMuted,
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm
  },
  errorNotice: {
    fontSize: 12,
    color: colors.statusRed,
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm
  },
  loading: {
    paddingVertical: spacing.lg,
    alignItems: 'center'
  },
  empty: {
    paddingVertical: spacing.lg,
    textAlign: 'center',
    color: colors.textMuted,
    fontSize: 13
  }
})
