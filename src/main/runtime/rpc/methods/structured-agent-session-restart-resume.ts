// The restart-resume offer: list it, act on it, or turn it down.
//
// Each method reaches for records on disk this process may not have opened yet, so each builds the
// host the way hold and reveal do. Listing takes nothing live and spends no live offer; acting goes
// through the host's single resume path, which re-derives eligibility rather than trusting the ids
// it is given.

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
      const host = requireStructuredHost(ctx)
      return {
        sessions: await host.restartResume.list(),
        // Acted-on offers whose agent did not carry on. Optional on the wire; older clients ignore it.
        failed: await host.restartResume.listFailures()
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
      const dismissed = await host.restartResume.dismiss(params.sessionIds)
      if (params.sessionIds === undefined) {
        // clearAll is the authoritative mutation: it removes pending and in-flight records, so a
        // second read would only add a new failure point after the user's explicit dismissal.
        return { dismissed, sessions: [], failed: [] }
      }
      return {
        dismissed,
        sessions: await host.restartResume.list(),
        failed: await host.restartResume.listFailures()
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
        structuredCallerFor(ctx).callerKey
      )
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
