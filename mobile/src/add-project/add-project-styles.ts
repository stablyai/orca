import { Platform, StyleSheet } from 'react-native'
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

// Field and button treatments follow TextInputModal so Add project reads like the app's other sheets.
export const addProjectStyles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingBottom: spacing.sm
  },
  backButton: {
    padding: spacing.xs
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary
  },
  message: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 2
  },
  label: {
    fontSize: typography.metaSize,
    fontWeight: '500',
    color: colors.textMuted,
    marginTop: spacing.md,
    marginBottom: spacing.xs
  },
  fieldRow: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  input: {
    flex: 1,
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary,
    borderRadius: radii.control,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? spacing.sm + 2 : spacing.sm,
    fontSize: TEXT_INPUT_FONT_SIZE,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  browseButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  hint: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    marginTop: spacing.xs
  },
  error: {
    fontSize: typography.metaSize,
    color: colors.statusRed,
    marginTop: spacing.sm
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md
  },
  cancelButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.control
  },
  submitButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.textPrimary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.control
  },
  buttonPressed: {
    opacity: 0.7
  },
  submitButtonDisabled: {
    opacity: 0.4
  },
  cancelText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  },
  submitText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '600'
  }
})
