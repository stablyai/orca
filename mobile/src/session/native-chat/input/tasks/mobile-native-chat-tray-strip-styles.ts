import { StyleSheet } from 'react-native'
import { radii, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'

/** The collapsible box every live-work strip above the composer shares. */
export const trayStripStylesSheet = themedStyleSheet((colors) => ({
  list: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.xs
  },
  box: {
    backgroundColor: colors.chatPanel,
    borderRadius: radii.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    overflow: 'hidden'
  },
  header: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md
  },
  groupLabel: {
    color: colors.textMuted,
    fontSize: 10,
    fontFamily: typography.monoFamily,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    paddingBottom: spacing.xs / 2
  },
  caretOpen: {
    transform: [{ rotate: '180deg' }]
  },
  pressed: {
    backgroundColor: colors.bgRaised
  }
}))
