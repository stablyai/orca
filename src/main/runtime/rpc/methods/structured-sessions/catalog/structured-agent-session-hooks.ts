import { isNativeLocalLocation } from '../../../../../../shared/execution-host'
import { HooksParams } from '../../../../../../shared/rpc-contract/structured-agent-session-hooks-params'
import { defineMethod } from '../../../core'
import {
  requireInstalledStructuredHost,
  structuredCallerFor
} from '../creation/structured-agent-session-gate'

export const STRUCTURED_AGENT_SESSION_HOOKS_METHODS = [
  defineMethod({
    name: 'agentSession.hooks',
    permission: 'workspace',
    params: HooksParams,
    handler: async ({ sessionId, trust }, ctx) => {
      if (trust && !structuredCallerFor(ctx).userClient) {
        throw new Error('Hook trust requires an interactive user client')
      }
      const host = await requireInstalledStructuredHost(ctx, sessionId)
      const saved = host.deps.store.getRecord(sessionId)
      if (!saved || saved.provider !== 'codex' || !isNativeLocalLocation(saved.location)) {
        throw new Error('Hook review is unavailable for this chat')
      }
      const accountHome = await host.deps.launchAccountHome?.(saved)
      const record = accountHome ? { ...saved, accountHome } : saved
      const review = host.deps.agents.registration(record.provider)?.adapter.reviewHooks
      if (!review) {
        throw new Error('Update the host to review Codex hooks')
      }
      return review(record, trust, AbortSignal.timeout(40_000))
    }
  })
]
