import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'

export const sessionOptionPickerStyles = themedStyleSheet(() => ({
  // The action row's only shrinkable item: a long label truncates before it pushes Send off.
  pillSlot: {
    flexShrink: 1,
    minWidth: 0
  },
  sheet: {
    paddingBottom: spacing.xs
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: spacing.lg
  },
  sheetTitle: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    fontWeight: '700',
    textAlign: 'center'
  },
  sheetNav: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  sheetHeaderSide: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center'
  },
  lockNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.lg
  },
  lockNoticeBody: {
    flex: 1,
    gap: spacing.xs
  },
  lockNoticeTitle: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  lockNoticeDescription: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  group: {
    overflow: 'hidden',
    borderRadius: radii.card,
    backgroundColor: colors.bgRaised
  },
  groupSpaced: {
    marginTop: spacing.md
  },
  divided: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.composerBorder
  },
  pressed: {
    opacity: 0.7
  }
}))
