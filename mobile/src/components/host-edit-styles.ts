import { Platform } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const hostEditStyles = themedStyleSheet(() => ({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  flex: {
    flex: 1
  },
  removeGroup: {
    marginTop: spacing.xl
  },
  form: {
    paddingTop: spacing.md,
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
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised
  },
  secondaryButtonText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  }
}))
