import { colors } from '../../theme/mobile-theme'
import type { MobileStatusToken } from './pr-checks-presentation'

// Resolves a pure-logic status token to a concrete mobile-theme color. Keeps the
// presentation module free of style imports while centralizing the mapping.
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
