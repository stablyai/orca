import { colors, feedback, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'

export const screenEdgeNavigationStyles = themedStyleSheet(() => ({
  layer: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    zIndex: 920
  },
  // Shared base
  edgeControlBase: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.composerBorder,
    backgroundColor: colors.composerSurface
  },
  edgeControlActive: {
    borderColor: colors.accentBlue,
    backgroundColor: colors.skillTokenSurface
  },
  edgeControlModifier: {
    borderColor: colors.skillToken
  },
  edgeControlDisabled: {
    opacity: feedback.disabledOpacity
  },
  edgeControlPressed: {
    opacity: 0.96
  },

  // Flavour 1: Pills (glassmorphic centered capsules)
  pillHorizontal: {
    width: 56,
    height: 28,
    borderRadius: radii.pill,
    opacity: 0.88
  },
  pillVertical: {
    width: 28,
    height: 56,
    borderRadius: radii.pill,
    opacity: 0.88
  },

  // Flavour 2: Strips (wide low-profile border touch rails)
  stripHorizontal: {
    height: 22,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised,
    borderColor: colors.borderSubtle,
    opacity: 0.78
  },
  stripVertical: {
    width: 22,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised,
    borderColor: colors.borderSubtle,
    opacity: 0.78
  },

  // Flavour 3: Orbs (compact circular floating buttons)
  orb: {
    width: 38,
    height: 38,
    borderRadius: radii.pill,
    opacity: 0.8
  },

  chevronGlyph: {
    borderTopWidth: 2.2,
    borderRightWidth: 2.2,
    borderRadius: 1.5
  },
  chevronUp: {
    marginTop: 3,
    transform: [{ rotate: '-45deg' }]
  },
  chevronDown: {
    marginBottom: 3,
    transform: [{ rotate: '135deg' }]
  },
  chevronLeft: {
    marginLeft: 3,
    transform: [{ rotate: '-135deg' }]
  },
  chevronRight: {
    marginRight: 3,
    transform: [{ rotate: '45deg' }]
  },

  modifierDot: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 5,
    height: 5,
    borderRadius: radii.pill,
    backgroundColor: colors.accentBlue
  },

  flavourChip: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    height: 26,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.composerBorder,
    backgroundColor: colors.composerSurface,
    opacity: 0.86
  },
  flavourChipPressed: {
    backgroundColor: colors.bgRaised,
    opacity: 1
  },
  flavourDot: {
    width: 7,
    height: 7,
    borderRadius: radii.pill,
    backgroundColor: colors.accentBlue
  },
  flavourChipText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textSecondary
  },

  // Mode picker sheet
  sheetBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xl,
    backgroundColor: colors.translucentFill
  },
  sheetCard: {
    borderRadius: radii.floating,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.sheetSurface,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    gap: spacing.xs
  },
  sheetTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary,
    paddingHorizontal: spacing.xs
  },
  sheetMessage: {
    fontSize: 13,
    color: colors.textSecondary,
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.xs
  },
  sheetOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.sm + 2,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: 'transparent'
  },
  sheetOptionSelected: {
    borderColor: colors.accentBlue,
    backgroundColor: colors.skillTokenSurface
  },
  sheetOptionPressed: {
    backgroundColor: colors.sheetGroup
  },
  sheetOptionLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary
  },
  sheetOptionCheck: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.accentBlue
  },
  sheetCancel: {
    marginTop: spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.control,
    backgroundColor: colors.sheetGroup
  },
  sheetCancelText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textSecondary
  }
}))
