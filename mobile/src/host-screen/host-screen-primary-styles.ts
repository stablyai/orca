import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

export const hostScreenPrimaryStyles = themedStyleSheet(() => ({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  topChromeSafeArea: {
    backgroundColor: colors.bgBase
  },
  hostPlatformText: {
    marginLeft: 16,
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 16
  }
}))
