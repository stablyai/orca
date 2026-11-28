import { radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'

export const customKeyModalStylesSheet = themedStyleSheet((colors) => ({
  kinds: {
    marginTop: spacing.xs,
    marginBottom: spacing.md
  },
  keyInput: {
    height: 56,
    fontFamily: typography.monoFamily,
    // Keep 22px key capture above input floor; binding seam would lower it to 16px merely to satisfy census (C7 ruling 12).
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center'
  },
  // Each cell's own inset makes the gap, so the grid's edges line up with the field above.
  keyGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -spacing.xs / 2
  },
  keyCellWrap: {
    paddingHorizontal: spacing.xs / 2,
    paddingVertical: spacing.xs / 2
  },
  keyCell: {
    height: 44,
    borderRadius: radii.control,
    backgroundColor: colors.sheetGroup,
    alignItems: 'center',
    justifyContent: 'center'
  },
  keyCellPressed: {
    backgroundColor: colors.translucentFill
  },
  keyCellSelected: {
    backgroundColor: colors.surfaceBright
  },
  keyCellText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
    fontFamily: typography.monoFamily
  },
  keyCellTextSelected: {
    color: colors.bgBase
  },
  enterGroup: {
    marginTop: spacing.lg
  },
  bottomSpace: {
    height: spacing.lg
  }
}))
