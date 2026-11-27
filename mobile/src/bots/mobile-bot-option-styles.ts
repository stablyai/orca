// Content-specific sheet copy; list rows and groups use the shared list primitives.
import { themedStyleSheet } from '../theme/themed-styles'

export const optionStylesSheet = themedStyleSheet((colors) => ({
  optionRowDetail: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 2
  }
}))
