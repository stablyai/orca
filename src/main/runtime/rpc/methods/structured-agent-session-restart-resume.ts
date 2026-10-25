// Build durable-record access lazily and scope every restart offer action to agents this client renders.
// Listing spends no offer; resume re-derives eligibility from host state, never trusts supplied ids.

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
    permission: 'workspace',
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
    // Explicit dismissal abandons markers; dialog close only snoozes so the status-bar offer remains.
    name: 'agentSession.restartResumableDismiss',
    permission: 'workspace',
    params: RestartResumableParams,
    handler: async (params, ctx) => {
      await ensureStructuredHostInstalled(ctx)
      const host = requireStructuredHost(ctx)
      // Offers this client was never shown stay for a client that can show them.
      const audience = structuredAgentsReadBy(ctx, host.knownAgentIds())
      const dismissed = await host.restartResume.dismiss(params.sessionIds, audience)
      if (params.sessionIds === undefined) {
        // Dismissal already removed everything this client sees; another read adds only a post-success failure point.
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
    // Reattach and ask agents to continue, for prompt/settings resume; legacy restartResume sends nothing.
    name: 'agentSession.restartContinue',
    permission: 'workspace',
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
    // Continue the exact interrupted turn, separate from restart offers; clients negotiate its capability and name a readable chat.
    name: 'agentSession.continueInterrupted',
    permission: 'workspace',
    params: ContinueInterruptedParams,
    handler: async (params, ctx) => {
      await ensureStructuredHostInstalled(ctx)
      const host = requireStructuredHost(ctx)
      return host.restartResume.continueInterrupted(params.sessionId, params.turnItemId)
    }
  }),
  defineMethod({
    // Keep published legacy reattach-only RPC answering no resume: agents now start only for work, and removal would break old clients.
    name: 'agentSession.restartResume',
    permission: 'workspace',
    params: RestartResumeParams,
    handler: async (_params, ctx) => {
      await ensureStructuredHostInstalled(ctx)
      requireStructuredHost(ctx)
      return { results: [] }
    }
  })
]
