import { themedStyleSheet } from '../theme/themed-styles'
import { COMPOSER_TEXT_SIZE } from '../components/composer-input/composer-input-styles'
import { LIST_ROW_PADDING } from '../components/list/ListGroup'
import { radii, spacing, typography } from '../theme/mobile-theme'

export const automationStylesSheet = themedStyleSheet((colors) => ({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  // Inset like Source Control's switch under its bar.
  tabs: { marginHorizontal: spacing.md, marginTop: spacing.sm, backgroundColor: colors.bgPanel },
  // Settings-style pages: sections carry their own spacing, as SettingsScreen's do.
  grouped: {
    flexGrow: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl
  },
  bottomBar: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    backgroundColor: colors.bgBase
  },
  meta: { color: colors.textSecondary, fontSize: typography.metaSize, lineHeight: 18 },
  error: { color: colors.statusRed, fontSize: typography.bodySize, lineHeight: 21 },
  // Text starts where row titles do: the row inset less the field's 1 pt edge. The filled grey reads on sheets and plain pages.
  input: {
    paddingVertical: spacing.md,
    paddingHorizontal: LIST_ROW_PADDING - 1,
    borderRadius: radii.control,
    backgroundColor: colors.translucentFill,
    fontSize: COMPOSER_TEXT_SIZE,
    minHeight: 44
  },
  multiline: { minHeight: 120, textAlignVertical: 'top' },
  placeField: { marginTop: spacing.sm },
  // Output reads as one group's text, set in the code face.
  output: {
    color: colors.textPrimary,
    paddingHorizontal: LIST_ROW_PADDING,
    paddingVertical: spacing.md,
    fontFamily: typography.monoFamily,
    fontSize: 13,
    lineHeight: 19
  }
}))
