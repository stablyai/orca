// The exact command behind one listed Worker Dock command row, for desktop chat readers only.
// One bounded read per dialog opening; anything not proven current answers `{ command: null }`.

import { BackgroundCommandParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import { agentSessionRefusalError } from '../../../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { defineMethod } from '../../../core'
import { installedStructuredSessionHost } from '../creation/structured-agent-session-gate'

export const STRUCTURED_AGENT_SESSION_BACKGROUND_COMMAND_METHOD = 'agentSession.backgroundCommand'

export const STRUCTURED_AGENT_SESSION_BACKGROUND_COMMAND_METHODS = [
  defineMethod({
    name: STRUCTURED_AGENT_SESSION_BACKGROUND_COMMAND_METHOD,
    permission: 'workspace',
    params: BackgroundCommandParams,
    handler: (params, ctx): { command: string | null } => {
      // Phones never receive exact commands, whatever they declare.
      if (ctx.clientKind === 'mobile') {
        throw agentSessionRefusalError('structured_agent_session_unsupported', {
          reason: 'clientCapabilityMissing'
        })
      }
      // The default membership gate and this session's agent audience, like history reads, but
      // never installing: a host built now has landed no command, so cold answers null.
      const host = installedStructuredSessionHost(ctx, params.sessionId)
      if (!host || host.sessionAgent(params.sessionId) !== 'codex') {
        return { command: null }
      }
      return {
        command: host.commandDetail(params.sessionId, {
          childWorkId: params.childWorkId,
          invocationId: params.invocation.invocationId,
          generation: params.invocation.generation
        })
      }
    }
  })
]
