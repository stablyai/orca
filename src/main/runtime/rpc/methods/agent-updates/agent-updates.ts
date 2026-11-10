import { defineMethod } from '../../core'
import {
  AgentUpdateRequestSchema,
  type AgentUpdatesState
} from '../../../../../shared/agent-updates/agent-update-types'
import {
  getAgentUpdatesState,
  refreshAgentUpdates,
  startAgentUpdates
} from '../../../../agent-updates/agent-update-service'
import { pickAgentUpdateSettings } from '../../../../agent-updates/check-agent-updates'

// Why not awaited: a check or update can outlast the RPC timeout; clients poll getState instead.
export const AGENT_UPDATE_METHODS = [
  defineMethod({
    name: 'agentUpdates.getState',
    permission: 'workspace',
    params: null,
    handler: (): AgentUpdatesState => getAgentUpdatesState()
  }),
  defineMethod({
    name: 'agentUpdates.refresh',
    permission: 'workspace',
    params: null,
    handler: (_params, { runtime }): AgentUpdatesState => {
      void refreshAgentUpdates(pickAgentUpdateSettings(runtime.requireStore().getSettings()))
      return getAgentUpdatesState()
    }
  }),
  defineMethod({
    name: 'agentUpdates.update',
    permission: 'host-admin',
    params: AgentUpdateRequestSchema,
    handler: (params, { runtime }): AgentUpdatesState => {
      void startAgentUpdates(
        params.agents,
        pickAgentUpdateSettings(runtime.requireStore().getSettings())
      )
      return getAgentUpdatesState()
    }
  })
]
