import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'
import {
  updateFailureWallOf,
  type MobileWebShellUpdateFailureFacts
} from './mobile-web-shell-update-failure'

/** What went on screen instead, read off the state the decision produced rather than decided twice. */
export function updateFailureOutcomeOf(
  state: MobileWebShellSessionState
): Pick<MobileWebShellUpdateFailureFacts, 'outcome' | 'wall'> {
  switch (state.kind) {
    case 'activating':
    case 'ready':
      return { outcome: 'opened-cached', wall: null }
    case 'native-route':
      return { outcome: 'native-route', wall: null }
    case 'wall':
      return { outcome: 'wall', wall: updateFailureWallOf(state.verdict) }
    case 'failed':
      return { outcome: 'failed', wall: null }
    case 'checking':
    case 'fetching':
    case 'offline':
      return { outcome: 'waiting', wall: null }
  }
}
