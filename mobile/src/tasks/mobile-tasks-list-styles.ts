import { StyleSheet, colors, spacing } from './mobile-tasks-dependencies'

export const mobileTasksListStyles = StyleSheet.create({
  pickerRepoDot: {
    width: 10,
    height: 10,
    borderRadius: 5
  },
  paginationFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator
  }
})
