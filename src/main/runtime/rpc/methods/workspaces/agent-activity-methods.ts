import { defineMethod } from '../../core'
import {
  AGENT_ACTIVITY_ORCHESTRATION_METHOD,
  AgentActivityClearParams,
  AgentActivityOrchestrationParams,
  AgentActivitySetReadParams,
  type AgentActivityOrchestrationResult
} from '../../../../../shared/rpc-contract/agent-activity/agent-activity-params'

// Desktop Agents-list read and clear for paired clients; the next worktree.ps already reflects them.
export const AGENT_ACTIVITY_METHODS = [
  defineMethod({
    name: 'agentActivity.setRead',
    permission: 'workspace',
    params: AgentActivitySetReadParams,
    handler: async (params, { runtime }) => {
      await runtime.applyAgentPaneActivity({
        kind: params.read ? 'read' : 'unread',
        paneKeys: params.paneKeys
      })
      return { applied: true }
    }
  }),
  defineMethod({
    name: 'agentActivity.clear',
    permission: 'workspace',
    params: AgentActivityClearParams,
    handler: async (params, { runtime }) => {
      await runtime.applyAgentPaneActivity({ kind: 'clear', paneKeys: params.paneKeys })
      return { applied: true }
    }
  }),
  // Paired desktops nest this host's workers by these; their own graph reply knows only their own Dispatches.
  defineMethod({
    name: AGENT_ACTIVITY_ORCHESTRATION_METHOD,
    permission: 'workspace',
    params: AgentActivityOrchestrationParams,
    handler: async (params, { runtime }): Promise<AgentActivityOrchestrationResult> =>
      runtime.readAgentOrchestrationSince(params.sinceRevision)
  })
]
