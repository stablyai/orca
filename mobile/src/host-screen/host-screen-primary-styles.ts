import { themedStyleSheet } from '../theme/themed-styles'

export const hostScreenPrimaryStylesSheet = themedStyleSheet((colors) => ({
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
