import { StyleSheet } from 'react-native'

import { colors, spacing, radii, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const mobileSessionCommandInputStyles = themedStyleSheet(() => ({
  createWarningBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  createWarningText: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 12,
    lineHeight: 16
  },
  createWarningDismiss: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -4
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    marginBottom: spacing.lg
  },
  createError: {
    color: colors.statusRed,
    fontSize: 13,
    marginBottom: spacing.sm
  },
  emptyActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.sm
  },
  createButton: {
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.button
  },
  createButtonDisabled: {
    opacity: 0.5
  },
  createButtonText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  keyboardDismissGlyph: {
    alignItems: 'center',
    height: 18,
    justifyContent: 'flex-start',
    position: 'relative',
    width: 18
  },
  keyboardDismissChevron: {
    bottom: -2,
    position: 'absolute'
  },
  liveInputCaptureDisabled: {
    opacity: 0.45
  },
  dictationButtonActive: {
    borderWidth: 1,
    borderColor: colors.textSecondary
  }
}))
