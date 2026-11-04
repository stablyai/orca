import { colors, feedback, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { LIST_ROW_PADDING } from './list/ListGroup'

// Drag-reorder rows keep their own layout: the reorder list fixes their height and adds the grip.
export const styles = themedStyleSheet(() => ({
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
  rowSublabel: {
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 2
  },
  keycap: {
    minWidth: 62,
    alignItems: 'center',
    backgroundColor: colors.translucentFill,
    borderRadius: radii.control,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  keycapText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily
  },
  deleteButton: {
    width: 32,
    height: 32,
    borderRadius: radii.control,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.translucentFill
  },
  deleteButtonPressed: {
    opacity: feedback.pressedOpacity
  }
}))
