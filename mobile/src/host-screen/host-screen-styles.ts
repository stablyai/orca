import { themedStyles } from '../theme/themed-styles'
import { hostScreenPrimaryStylesSheet } from './host-screen-primary-styles'
import { hostScreenSecondaryStylesSheet } from './host-screen-secondary-styles'

export const hostScreenStylesSheet = themedStyles((_colors, scheme) => ({
  ...hostScreenPrimaryStylesSheet.resolve(scheme),
  ...hostScreenSecondaryStylesSheet.resolve(scheme)
}))
