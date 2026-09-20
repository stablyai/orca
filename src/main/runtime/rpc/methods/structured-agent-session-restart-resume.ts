// `agentSession.restartResumable` / `agentSession.restartResume` — the restart-resume offer.
//
// Both reach for records on disk this process may not have opened yet, so they build the host the
// way hold and reveal do. Listing is read-only and takes nothing live; resuming goes through the
// host's single resume path, which re-derives eligibility rather than trusting the ids it is given.

import { defineMethod } from '../core'
import {
  ensureStructuredHostInstalled,
  requireStructuredHost,
  structuredCallerFor
} from './structured-agent-session-gate'
import { RestartResumableParams, RestartResumeParams } from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_RESTART_RESUME_METHODS = [
  defineMethod({
    name: 'agentSession.restartResumable',
    params: RestartResumableParams,
    handler: async (_params, ctx) => {
      await ensureStructuredHostInstalled(ctx)
      return { sessions: await requireStructuredHost(ctx).restartResume.list() }
    }
  }),
  defineMethod({
    // Spends the markers without resuming; see the collaborator for why turning the offer down
    // consumes it rather than leaving it to return at every launch.
    name: 'agentSession.restartResumableDismiss',
    params: RestartResumableParams,
    handler: async (_params, ctx) => {
      await ensureStructuredHostInstalled(ctx)
      return { dismissed: await requireStructuredHost(ctx).restartResume.dismiss() }
    }
  }),
  defineMethod({
    // Reconnect AND ask each reconnected agent to carry on. Separate from `restartResume` on
    // purpose: that method sends nothing, and the automatic-reconnect setting only ever calls it,
    // so no configuration can reach this one.
    name: 'agentSession.restartContinue',
    params: RestartResumeParams,
    handler: async (params, ctx) => {
      await ensureStructuredHostInstalled(ctx)
      const host = requireStructuredHost(ctx)
      return host.restartResume.continueAfterRestart(
        params.sessionIds,
        structuredCallerFor(ctx).callerKey
      )
    }
  }),
  defineMethod({
    name: 'agentSession.restartResume',
    params: RestartResumeParams,
    handler: async (params, ctx) => {
      await ensureStructuredHostInstalled(ctx)
      const host = requireStructuredHost(ctx)
      return {
        results: await host.restartResume.resume(
          params.sessionIds,
          structuredCallerFor(ctx).callerKey
        )
      }
    }
  })
]
