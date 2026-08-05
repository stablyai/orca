import { StyleSheet } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'

export const worktreeDeleteConfirmationStyles = StyleSheet.create({
  content: {
    paddingBottom: spacing.lg
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary
  },
  message: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    lineHeight: 20
  },
  buttons: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  button: {
    flex: 1,
    paddingVertical: spacing.sm + 2,
    borderRadius: 10,
    alignItems: 'center'
  },
  cancelButton: {
    backgroundColor: colors.bgPanel
  },
  destructiveButton: {
    backgroundColor: colors.statusRed
  },
  pressedButton: {
    opacity: 0.7
  },
  cancelText: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.textSecondary
  },
  destructiveText: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: '#fff'
  }
})
