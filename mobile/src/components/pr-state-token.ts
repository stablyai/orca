import type { MobileStatusToken } from './pr-sidebar/pr-checks-presentation'

// Share status tokens between workspace PR badge and sidebar to prevent color drift, matching desktop ReviewIcon.
// Accept raw generic hosted-review strings across providers: merged purple, open green, closed red, draft/unknown muted.
export function prStateToken(state: string): MobileStatusToken {
  switch (state.toLowerCase()) {
    case 'merged':
      return 'statusPurple'
    case 'open':
      return 'statusGreen'
    case 'closed':
      return 'statusRed'
    default:
      return 'textSecondary'
  }
}
