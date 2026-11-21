// Content-specific sheet copy; list rows and groups use the shared list primitives.
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const optionStyles = themedStyleSheet(() => ({
  optionRowDetail: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 2
  },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm }
}))
