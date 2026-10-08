// The restart-resume offer: list it, act on it, or turn it down.
//
// Each method reaches for records on disk this process may not have opened yet, so each builds the
// host the way hold and reveal do. Listing takes nothing live and spends no live offer; acting goes
// through the host's single resume path, which re-derives eligibility rather than trusting the ids
// it is given. Every method acts only on offers for agents the calling client can show.

import { defineMethod } from '../core'
import {
  ensureStructuredHostInstalled,
  requireStructuredHost,
  structuredCallerFor
} from './structured-agent-session-gate'
import {
  ContinueInterruptedParams,
  RestartResumableParams,
  RestartResumeParams
} from './structured-agent-session-schemas'
import { structuredAgentsReadBy } from './structured-agent-session-policy'

export const STRUCTURED_AGENT_SESSION_RESTART_RESUME_METHODS = [
  defineMethod({
    name: 'agentSession.restartResumable',
    params: RestartResumableParams,
    handler: async (_params, ctx) => {
      await ensureStructuredHostInstalled(ctx)
      const host = requireStructuredHost(ctx)
      const audience = structuredAgentsReadBy(ctx, host.knownAgentIds())
      return {
        sessions: await host.restartResume.list(audience),
        // Acted-on offers whose agent did not carry on. Optional on the wire; older clients ignore it.
        failed: await host.restartResume.listFailures(audience)
      }
    }
  }),
  defineMethod({
    // Explicitly abandons the markers without resuming. Closing the dialog is a snooze and does
    // not call this method, so the status-bar entry can reopen the offer later.
    name: 'agentSession.restartResumableDismiss',
    params: RestartResumableParams,
    handler: async (params, ctx) => {
      await ensureStructuredHostInstalled(ctx)
      const host = requireStructuredHost(ctx)
      // Offers this client was never shown stay for a client that can show them.
      const audience = structuredAgentsReadBy(ctx, host.knownAgentIds())
      const dismissed = await host.restartResume.dismiss(params.sessionIds, audience)
      if (params.sessionIds === undefined) {
        // The dismissal removed every pending and in-flight record this client sees, so a second
        // read would only add a new failure point after the user's explicit dismissal.
        return { dismissed, sessions: [], failed: [] }
      }
      return {
        dismissed,
        sessions: await host.restartResume.list(audience),
        failed: await host.restartResume.listFailures(audience)
      }
    }
  }),
  defineMethod({
    // Reattach AND ask each reattached agent to carry on — what the desktop prompt calls resuming,
    // and what an opted-in launch runs without asking. Separate from `restartResume`, which sends
    // nothing, but reachable from a setting rather than only from a button.
    name: 'agentSession.restartContinue',
    params: RestartResumeParams,
    handler: async (params, ctx) => {
      await ensureStructuredHostInstalled(ctx)
      const host = requireStructuredHost(ctx)
      return host.restartResume.continueAfterRestart(
        params.sessionIds,
        structuredCallerFor(ctx).callerKey,
        structuredAgentsReadBy(ctx, host.knownAgentIds())
      )
    }
  }),
  defineMethod({
    // Continue on a reply an Orca stop cut off: the same continuation, bound to the cut turn
    // instead of an offer. Clients gate it on AGENT_SESSION_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY.
    // It names one chat the client shows, as a send does, so no agent audience applies.
    name: 'agentSession.continueInterrupted',
    params: ContinueInterruptedParams,
    handler: async (params, ctx) => {
      await ensureStructuredHostInstalled(ctx)
      const host = requireStructuredHost(ctx)
      return host.restartResume.continueInterrupted(params.sessionId, params.turnItemId)
    }
  }),
  defineMethod({
    // Reattach only, no send. Reattaching is nothing now — an agent starts only for work — so this
    // answers that nothing was resumed. No Orca surface calls it, but it is a PUBLISHED wire
    // method, so dropping it is a wire removal an older client would meet as an unknown method.
    name: 'agentSession.restartResume',
    params: RestartResumeParams,
    handler: async (_params, ctx) => {
      await ensureStructuredHostInstalled(ctx)
      requireStructuredHost(ctx)
      return { results: [] }
    }
  })
]
