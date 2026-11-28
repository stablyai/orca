import { spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { LIST_ROW_PADDING } from '../components/list/ListGroup'

export const stylesSheet = themedStyleSheet((colors) => ({
  // A grouped page, as Settings and Edit computer are: sheetGroup groups on the grey page.
  container: {
    flex: 1,
    backgroundColor: colors.groupedPage
  },
  bar: { backgroundColor: colors.groupedPage },
  scroll: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm
  },
  groupNote: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    lineHeight: 18,
    paddingHorizontal: LIST_ROW_PADDING,
    paddingTop: spacing.sm
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
