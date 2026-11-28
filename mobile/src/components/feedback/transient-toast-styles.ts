import { StyleSheet } from 'react-native'
import { spacing, radii } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'

export const transientToastStylesSheet = themedStyleSheet((colors) => ({
  toast: {
    position: 'absolute',
    bottom: spacing.lg,
    alignSelf: 'center',
    left: 0,
    right: 0,
    alignItems: 'center'
  },
  toastText: {
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    color: colors.textPrimary,
    fontSize: 13,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.surface,
    overflow: 'hidden'
  },
  withAction: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  message: { color: colors.textPrimary, fontSize: 13, fontWeight: '600' },
  action: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  actionPressed: { opacity: 0.6 }
}))
