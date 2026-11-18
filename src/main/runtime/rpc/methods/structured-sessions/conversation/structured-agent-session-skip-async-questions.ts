import { SkipAsyncQuestionsParams } from '../../../../../../shared/rpc-contract/structured-agent-session/skip-async-questions-params'
import { defineMethod } from '../../../core'
import { requireInstalledStructuredHost } from '../creation/structured-agent-session-gate'

export const STRUCTURED_AGENT_SESSION_SKIP_ASYNC_QUESTIONS_METHODS = [
  defineMethod({
    name: 'agentSession.skipAsyncQuestions',
    permission: 'workspace',
    params: SkipAsyncQuestionsParams,
    handler: async (params, ctx) => {
      const host = await requireInstalledStructuredHost(ctx, params.sessionId)
      await host.skipAsyncQuestions(params.sessionId, params.itemId)
      return { ok: true as const }
    }
  })
]
