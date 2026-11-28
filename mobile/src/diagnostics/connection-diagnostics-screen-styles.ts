import { spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { LIST_ROW_PADDING } from '../components/list/ListGroup'

export const connectionDiagnosticsScreenStylesSheet = themedStyleSheet((colors) => ({
  content: { flex: 1 },
  log: { flex: 1, marginTop: spacing.lg },
  emptyText: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    lineHeight: 18,
    paddingHorizontal: LIST_ROW_PADDING
  }
}))
