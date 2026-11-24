import { prStateToken } from '../../source-control/review/status/pr-state-token'
import { statusColor } from '../../source-control/review/status/pr-sidebar-status-color'

// Use shared prStateToken to match sidebar badge: merged purple, open green, closed red, draft/unknown muted.
export function prStateColor(state: string): string {
  return statusColor(prStateToken(state))
}
