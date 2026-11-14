import { StyleSheet } from 'react-native'
import { colors, radii, spacing } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'

/** The collapsible box every live-work strip above the composer shares. */
export const trayStripStyles = themedStyleSheet(() => ({
  list: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.xs
  },
  box: {
    backgroundColor: colors.bgPanel,
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
  caretOpen: {
    transform: [{ rotate: '180deg' }]
  },
  pressed: {
    backgroundColor: colors.bgRaised
  }
}))
