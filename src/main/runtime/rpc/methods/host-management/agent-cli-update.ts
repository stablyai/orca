// Updates for the user's own agent CLIs, checked and run on the host they are installed on.

import {
  AgentCliUpdateCheckParams,
  AgentCliUpdateRunParams
} from '../../../../../shared/rpc-contract/host-management/agent-cli-update-params'
import {
  checkAgentCliUpdates,
  onAgentCliUpdateFinished,
  runAgentCliUpdate
} from '../../../../agent-cli-update/agent-cli-update-service'
import { defineMethod, defineStreamingMethod } from '../../core'
import { bindStructuredAgentSessionStream } from '../structured-sessions/subscriptions/structured-agent-session-status-stream'

export const AGENT_CLI_UPDATE_METHODS = [
  defineMethod({
    name: 'agentCliUpdate.check',
    permission: 'workspace',
    params: AgentCliUpdateCheckParams,
    handler: async ({ agents }, { runtime }) => ({
      updates: await checkAgentCliUpdates(runtime.requireStore().getSettings(), agents)
    })
  }),
  defineMethod({
    name: 'agentCliUpdate.run',
    permission: 'host-admin',
    params: AgentCliUpdateRunParams,
    handler: ({ agent }, { runtime }) =>
      runAgentCliUpdate(agent, runtime.requireStore().getSettings())
  }),
  // Names each agent whose update finished, so every client checks again.
  defineStreamingMethod({
    name: 'agentCliUpdate.subscribe',
    permission: 'workspace',
    params: null,
    handler: async (_params, ctx, emit) => {
      let dispose = (): void => {}
      const frame = ctx.requestId ? `:${ctx.requestId}` : ''
      const stream = bindStructuredAgentSessionStream(
        ctx,
        `agentCliUpdate:${ctx.connectionId ?? 'local'}${frame}`,
        () => dispose()
      )
      if (stream.isClosed()) {
        return
      }
      dispose = onAgentCliUpdateFinished((agent) => {
        if (!stream.isClosed()) {
          emit({ agent })
        }
      })
      // Tells the client the stream is open.
      emit({ agent: null })
    }
  })
] as const
