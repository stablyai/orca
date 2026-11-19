// Content-specific sheet copy; list rows and groups use the shared list primitives.
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const optionStyles = themedStyleSheet(() => ({
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2,
    gap: spacing.sm
  },
  filterRowText: {
    flex: 1,
    fontSize: 15,
    color: colors.textPrimary
  },
  optionRowLabel: {
    flex: 1
  },
  summaryTitle: {
    fontSize: 15,
    fontWeight: '500',
    color: colors.textPrimary
  },
  optionRowDetail: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 2
  },
  optionRowDisabled: {
    opacity: 0.5
  },
  optionPageTitle: {
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.md
  },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm }
}))
