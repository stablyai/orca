import { StyleSheet } from 'react-native'
import {
  LIST_LEADING_INSET,
  LIST_LEADING_SLOT,
  LIST_ROW_PADDING
} from '../components/list/ListGroup'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const styles = themedStyleSheet(() => ({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  header: {
    backgroundColor: colors.bgBase
  },
  scopeTabs: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    backgroundColor: colors.bgPanel
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: LIST_LEADING_INSET,
    backgroundColor: colors.borderSubtle
  },
  // ListRow's two-line anatomy: 60 pt, a 24 pt leading slot, 15 pt title, one 13 pt line.
  row: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: LIST_ROW_PADDING,
    paddingVertical: spacing.sm
  },
  // A translucent wash: bgRaised is the page's own colour in light mode.
  rowPressed: {
    backgroundColor: colors.translucentFill
  },
  leading: {
    width: LIST_LEADING_SLOT,
    alignItems: 'center',
    justifyContent: 'center'
  },
  main: {
    flex: 1,
    minWidth: 0,
    gap: 2
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  title: {
    flex: 1,
    minWidth: 0,
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '500'
  },
  timeAgo: {
    color: colors.textMuted,
    fontSize: 13,
    fontVariant: ['tabular-nums']
  },
  detail: {
    color: colors.textSecondary,
    fontSize: 13
  },
  here: {
    fontWeight: '500'
  }
}))
