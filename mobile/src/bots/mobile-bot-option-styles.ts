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
  filterModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.md
  },
  filterModalHeading: {
    flexShrink: 1
  },
  filterModalTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary
  },
  optionBack: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    alignSelf: 'flex-start',
    paddingVertical: spacing.xs,
    marginBottom: spacing.xs
  },
  optionBackText: {
    fontSize: 14,
    color: colors.textSecondary
  },
  optionPageTitle: {
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.md
  },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm }
}))
