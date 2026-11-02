import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const hubStyles = themedStyleSheet(() => ({
  // Inset like the Tasks and Agent History switches in their NavBar accessory rows.
  segments: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    backgroundColor: colors.bgPanel
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  chipPressed: {
    opacity: 0.7
  },
  chipIcon: {
    width: 18,
    alignItems: 'center'
  },
  chipNumber: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  statePill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth
  },
  statePillText: {
    fontSize: typography.metaSize,
    fontWeight: '700'
  },
  rollup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4
  },
  rollupText: {
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  comment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4
  },
  commentText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  chipSpacer: {
    flex: 1,
    minWidth: spacing.sm
  },
  chipCreateText: {
    color: colors.accentBlue,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  chipMutedText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  changesControls: {
    paddingHorizontal: spacing.lg,
    marginTop: spacing.xs
  },
  tabBody: {
    flex: 1
  },
  tabBodyHidden: {
    display: 'none'
  },
  // A pushed screen (Checks, Comments) covers the hub until the shared pager owns the motion.
  screenLayer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.bgBase
  }
}))
