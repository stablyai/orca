import { StyleSheet } from 'react-native'
import { colors, textStyles } from '../theme/mobile-theme'

export const hostScreenPrimaryStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  // Opaque and the canvas colour: the bar only gains a hairline once rows scroll under it.
  topChromeSafeArea: {
    backgroundColor: colors.bgBase
  },
  // A desktop's machine/platform line; the Tasks header reuses it under its title.
  hostPlatformText: {
    ...textStyles.caption,
    marginLeft: 16,
    color: colors.textSecondary
  }
})
