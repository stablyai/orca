import type { MobileWebShellSession, MobileWebShellStep } from './mobile-web-shell-session-contract'
import {
  readFailureSide,
  type MobileWebShellUpdateFailureCause,
  type MobileWebShellUpdateFailureFacts
} from './mobile-web-shell-update-failure'
import { updateFailureOutcomeOf } from './mobile-web-shell-update-failure-outcome'
import { cachedGenerationWall, gateState, gateVerdict } from './mobile-web-shell-gates'
import { openByOwnRoutes } from './mobile-web-shell-cached-generation'
import { step } from './mobile-web-shell-session-step'

// Record the resulting decision once for Troubleshoot; release builds forward no console logs.
export function onDownloadFailed(
  session: MobileWebShellSession,
  cause: MobileWebShellUpdateFailureCause
): MobileWebShellStep {
  const decided = decideDownloadFailed(session, cause)
  const failure: MobileWebShellUpdateFailureFacts = {
    ...cause,
    offeredBuildId: session.requestedBuildId,
    cachedBuildId: session.cached?.buildId ?? null,
    ...updateFailureOutcomeOf(decided.session.state)
  }
  return { ...decided, effects: [...decided.effects, { kind: 'record-update-failure', failure }] }
}

// Fall back to intact cached bytes under their own routes, checking compatibility when the host remains reachable.
// Name only bundle refusals: link loss cannot establish an update existed; absent cache still gets download failure.
function decideDownloadFailed(
  session: MobileWebShellSession,
  cause: MobileWebShellUpdateFailureCause
): MobileWebShellStep {
  const cached = session.cached
  const gates = session.gates
  if (cached === null || gates === null) {
    return step(session, {
      state: { kind: 'failed', reason: 'download-failed', retriedOnce: session.retriedOnce }
    })
  }
  // Read current gates because they can change while fetching without restarting the flow.
  const verdict = gateVerdict(gates)
  const gated = gateState(verdict, session.retriedOnce)
  if (gated !== null) {
    return step(session, { state: gated })
  }
  return openByOwnRoutes(session, cached, {
    // Missing cached routes remain a retryable download failure after the new manifest claimed them or never arrived.
    unclaimed: { kind: 'failed', reason: 'download-failed', retriedOnce: session.retriedOnce },
    served: { updateNotice: readFailureSide(cause.reason) === 'bundle' ? 'update-failed' : null },
    wall: cachedGenerationWall(verdict, gates, cached.compat)
  })
}
