import {
  StyleSheet,
  Platform,
  colors,
  spacing,
  textStyles,
  MIN_TOUCH_TARGET
} from './mobile-tasks-dependencies'

export const mobileTasksProjectPickerStyles = StyleSheet.create({
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 52,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm
  },
  pickerRowWithAction: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  pickerRowMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 52,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm
  },
  pickerCheck: {
    width: 18,
    alignItems: 'center'
  },
  pickerContent: {
    flex: 1,
    minWidth: 0
  },
  pickerLabel: {
    ...textStyles.body,
    color: colors.textPrimary
  },
  monoText: {
    fontFamily: Platform.select({
      ios: 'Menlo',
      android: 'monospace',
      default: 'monospace'
    }),
    fontSize: 15
  },
  pickerSubtitle: {
    ...textStyles.subhead,
    color: colors.textSecondary
  },
  iconActionButton: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center'
  }
})
