import { createThemedStyles } from '../theme/mobile-themed-styles'
import { hostScreenPrimaryStyles } from './host-screen-primary-styles'
import { hostScreenSecondaryStyles } from './host-screen-secondary-styles'

export const hostScreenStyles = createThemedStyles(() => ({
  ...hostScreenPrimaryStyles,
  ...hostScreenSecondaryStyles
}))
