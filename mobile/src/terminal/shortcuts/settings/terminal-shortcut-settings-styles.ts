import { spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { LIST_ROW_PADDING } from '../../../components/list/ListGroup'

// Drag-reorder rows keep their own layout: the reorder list fixes their height and adds the grip.
// Text matches ListRow's title, value and subtitle so a row reads the same in and out of Edit.
export const stylesSheet = themedStyleSheet((colors) => ({
  reorderRowContent: {
    flex: 1,
    height: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingLeft: LIST_ROW_PADDING
  },
  rowContent: {
    flex: 1,
    minWidth: 0
  },
  rowLabel: {
    fontSize: 15,
    color: colors.textPrimary
  },
  rowLabelEmphasis: {
    fontWeight: '500'
  },
  rowValue: {
    fontSize: 15,
    color: colors.textSecondary
  },
  rowSublabel: {
    fontSize: 13,
    color: colors.textSecondary,
    fontFamily: typography.monoFamily,
    marginTop: 2
  }
}))
