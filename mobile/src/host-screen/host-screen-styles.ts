import { themedStyles } from '../theme/themed-styles'
import { hostScreenPrimaryStyles } from './host-screen-primary-styles'
import { hostScreenSecondaryStyles } from './host-screen-secondary-styles'

export const hostScreenStyles = themedStyles(() => ({
  ...hostScreenPrimaryStyles,
  ...hostScreenSecondaryStyles
}))
