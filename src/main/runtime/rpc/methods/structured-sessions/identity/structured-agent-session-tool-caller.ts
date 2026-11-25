import { ToolCallerParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import { sharedToolProcessCaller } from '../../../../agent-session/environment/shared-tool-process-callers'
import { defineMethod } from '../../../core'

export const STRUCTURED_AGENT_SESSION_TOOL_CALLER_METHODS = [
  defineMethod({
    // A tool in a process several chats share trades its session's token for that chat's identity.
    name: 'agentSession.toolCaller',
    permission: 'workspace',
    share: 'not-shared',
    params: ToolCallerParams,
    handler: async (params, ctx): Promise<{ env: Readonly<Record<string, string>> | null }> => {
      // Only this host's own CLI runs in the tool process that holds the token.
      if (ctx.caller?.kind !== 'local-cli') {
        throw new Error('forbidden')
      }
      return { env: sharedToolProcessCaller(params.token) }
    }
  })
]
