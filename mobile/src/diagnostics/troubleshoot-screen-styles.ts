import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { LIST_LEADING_INSET, LIST_ROW_PADDING } from '../components/list/ListGroup'

export const troubleshootScreenStyles = themedStyleSheet(() => ({
  scroll: {
    flex: 1
  },
  checkDetail: {
    fontSize: typography.metaSize,
    color: colors.textMuted
  },
  checkDetailFail: {
    color: colors.statusRed
  },
  group: {
    marginBottom: spacing.lg
  },
  // Steps start under the issue title, past its icon.
  accordionBody: {
    paddingLeft: LIST_LEADING_INSET,
    paddingRight: LIST_ROW_PADDING,
    paddingBottom: spacing.md,
    gap: spacing.xs
  },
  noteBody: {
    paddingHorizontal: LIST_ROW_PADDING,
    paddingVertical: spacing.md,
    gap: spacing.xs
  },
  stepRow: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  bullet: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    lineHeight: 18
  },
  stepText: {
    flex: 1,
    fontSize: typography.metaSize,
    color: colors.textMuted,
    lineHeight: 18
  }
}))
