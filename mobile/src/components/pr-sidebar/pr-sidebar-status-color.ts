import { colors } from '../../theme/mobile-theme'
import type { MobileStatusToken } from './pr-checks-presentation'

// Centralize token→theme color mapping while keeping presentation logic style-free.
export function statusColor(token: MobileStatusToken): string {
  switch (token) {
    case 'statusGreen':
      return colors.statusGreen
    case 'statusAmber':
      return colors.statusAmber
    case 'statusRed':
      return colors.statusRed
    case 'statusPurple':
      return colors.statusPurple
    default:
      return colors.textSecondary
  }
}
