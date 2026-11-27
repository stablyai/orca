import { ToolCallerParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import { sharedToolProcessCaller } from '../../../../agent-session/environment/shared-tool-process-callers'
import { sharedToolCallerStore } from '../../../../agent-session/environment/shared-tool-caller-store'
import { defineMethod } from '../../../core'

export const STRUCTURED_AGENT_SESSION_TOOL_CALLER_METHODS = [
  defineMethod({
    // A tool in a process several chats share trades its session's token for that chat's identity.
    name: 'agentSession.toolCaller',
    permission: 'workspace',
    params: ToolCallerParams,
    handler: async (
      params,
      ctx
    ): Promise<{ env: Readonly<Record<string, string>> | null; locked?: true }> => {
      // Only this host's own CLI runs in the tool process that holds the token.
      if (ctx.caller?.kind !== 'local-cli') {
        throw new Error('forbidden')
      }
      const env = await sharedToolProcessCaller(params.token)
      // A kept caller the keychain hasn't opened yet may be this one: say so, not that it ended.
      return env || !sharedToolCallerStore.hasLocked() ? { env } : { env, locked: true }
    }
  })
]
