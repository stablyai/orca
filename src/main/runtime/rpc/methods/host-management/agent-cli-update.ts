// Updates for the user's own agent CLIs, checked and run on the host they are installed on.

import { AgentCliUpdateRunParams } from '../../../../../shared/rpc-contract/host-management/agent-cli-update-params'
import {
  checkAgentCliUpdates,
  runAgentCliUpdate
} from '../../../../agent-cli-update/agent-cli-update-service'
import { defineMethod } from '../../core'

export const AGENT_CLI_UPDATE_METHODS = [
  defineMethod({
    name: 'agentCliUpdate.check',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => ({
      updates: await checkAgentCliUpdates(runtime.requireStore().getSettings())
    })
  }),
  defineMethod({
    name: 'agentCliUpdate.run',
    permission: 'host-admin',
    params: AgentCliUpdateRunParams,
    handler: ({ agent }, { runtime }) =>
      runAgentCliUpdate(agent, runtime.requireStore().getSettings())
  })
] as const
