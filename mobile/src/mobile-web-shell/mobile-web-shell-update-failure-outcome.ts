import type {
  MobileWebShellSession,
  MobileWebShellSessionEffect,
  MobileWebShellSessionState
} from './mobile-web-shell-session-contract'
import {
  updateFailureWallOf,
  type MobileWebShellUpdateFailureCause,
  type MobileWebShellUpdateFailureFacts
} from './mobile-web-shell-update-failure'

// Troubleshoot's record of a failed update: what was offered, what was cached, and where the session landed.
export function updateFailureRecordEffect(
  session: MobileWebShellSession,
  cause: MobileWebShellUpdateFailureCause,
  landed: MobileWebShellSessionState
): MobileWebShellSessionEffect {
  return {
    kind: 'record-update-failure',
    failure: {
      ...cause,
      offeredBuildId: session.requestedBuildId,
      cachedBuildId: session.cached?.buildId ?? null,
      ...updateFailureOutcomeOf(landed)
    }
  }
}

function updateFailureOutcomeOf(
  state: MobileWebShellSessionState
): Pick<MobileWebShellUpdateFailureFacts, 'outcome' | 'wall'> {
  switch (state.kind) {
    case 'activating':
    case 'ready':
      return { outcome: 'opened-cached', wall: null }
    case 'route-unavailable':
      return { outcome: 'route-unavailable', wall: null }
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
