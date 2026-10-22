import { Platform, StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export const hostEditStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  flex: {
    flex: 1
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.sm
  },
  backButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center'
  },
  heading: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 20,
    fontWeight: '700'
  },
  saveButton: {
    minWidth: 64,
    height: 34,
    paddingHorizontal: spacing.md,
    borderRadius: radii.button,
    backgroundColor: colors.surfaceBright,
    alignItems: 'center',
    justifyContent: 'center'
  },
  saveButtonDisabled: {
    opacity: 0.4
  },
  saveButtonText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  form: {
    paddingHorizontal: spacing.lg,
    gap: spacing.sm
  },
  help: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    lineHeight: 20,
    marginBottom: spacing.sm
  },
  label: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '500',
    marginTop: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.4
  },
  input: {
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.row,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? 12 : 10
  },
  hint: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    lineHeight: 16
  },
  preview: {
    marginTop: spacing.sm,
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : typography.monoFamily
  },
  previewError: {
    marginTop: spacing.sm,
    color: colors.statusRed,
    fontSize: typography.bodySize
  },
  errorText: {
    color: colors.statusRed,
    fontSize: typography.bodySize,
    marginTop: spacing.md
  },
  errorState: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    gap: spacing.md
  },
  loadingState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  secondaryButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  secondaryButtonText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  }
})
