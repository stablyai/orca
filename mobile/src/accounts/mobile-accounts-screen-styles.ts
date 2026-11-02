import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { LIST_ROW_PADDING } from '../components/list/ListGroup'

export const styles = themedStyleSheet(() => ({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  scroll: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm
  },
  // On a screen, not a sheet: one step above the page, as the other screen groups are.
  group: {
    backgroundColor: colors.bgPanel
  },
  usageRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.xs
  },
  errorText: {
    fontSize: typography.metaSize,
    color: colors.statusRed
  },
  footerHint: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: LIST_ROW_PADDING,
    paddingTop: spacing.md
  },
  footerHintText: {
    flex: 1,
    fontSize: typography.metaSize,
    color: colors.textMuted,
    lineHeight: 18
  }
}))
