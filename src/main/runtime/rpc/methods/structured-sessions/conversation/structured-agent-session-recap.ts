// `/recap`: a transient OpenCode summary written back as an Orca note, like `/resume`'s rows.

import { defineMethod } from '../../../core'
import { requireInstalledStructuredHost } from '../creation/structured-agent-session-gate'
import { OptionsParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import {
  OpenCodeRecapError,
  recapStructuredOpenCodeSession
} from '../../../../../opencode/recap/opencode-session-recap'

export const STRUCTURED_AGENT_SESSION_RECAP_METHODS = [
  defineMethod({
    name: 'agentSession.recap',
    permission: 'workspace',
    params: OptionsParams,
    handler: async (params, ctx) => {
      const host = await requireInstalledStructuredHost(ctx, params.sessionId)
      try {
        return await recapStructuredOpenCodeSession(host, params.sessionId)
      } catch (error) {
        if (error instanceof OpenCodeRecapError) {
          throw new Error(error.message)
        }
        throw error
      }
    }
  })
]
