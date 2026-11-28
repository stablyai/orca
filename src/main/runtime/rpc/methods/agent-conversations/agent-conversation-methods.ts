import { defineMethod } from '../../core'
import {
  AgentCloseParams,
  AgentListParams,
  AgentReadParams,
  AgentShowParams
} from '../../../../../shared/rpc-contract/agent-conversation-params'
import type {
  AgentCloseResult,
  AgentListResult,
  AgentReadResult,
  AgentShowResult
} from '../../../../../shared/agent-conversations/agent-conversation-contracts'
import { closeAgentConversation } from '../../../agent-conversations/agent-conversation-close'
import {
  agentConversationPlaces,
  projectAgentConversationList
} from '../../../agent-conversations/agent-conversation-list'
import { resolveAgentConversation } from '../../../agent-conversations/agent-conversation-address'
import { readAgentConversation } from '../../../agent-conversations/agent-conversation-read'

// Listing reads every workspace's open agents, so no workspace page may hide one.
const AGENT_LIST_WORKTREE_LIMIT = 10_000

/** `orca agent list/show/read/close`: agents by their Orca session ID, chats and terminals alike.
 *  list, show and read never send to, start or wake an agent; close only closes open tabs. */
export const AGENT_CONVERSATION_METHODS = [
  defineMethod({
    name: 'agent.list',
    permission: 'workspace',
    params: AgentListParams,
    handler: async (params, { runtime }): Promise<AgentListResult> =>
      projectAgentConversationList(
        await runtime.getWorktreePs(AGENT_LIST_WORKTREE_LIMIT, true, false, params.worktreeId),
        params
      )
  }),
  defineMethod({
    name: 'agent.show',
    permission: 'workspace',
    params: AgentShowParams,
    handler: async (params, { runtime }): Promise<AgentShowResult> => {
      const resolved = await resolveAgentConversation(runtime, params.id)
      return {
        orcaSessionId: resolved.orcaSessionId,
        kind: resolved.kind,
        places: await agentConversationPlaces(runtime, resolved)
      }
    }
  }),
  defineMethod({
    name: 'agent.read',
    permission: 'workspace',
    params: AgentReadParams,
    handler: async (params, ctx): Promise<AgentReadResult> =>
      readAgentConversation(ctx, await resolveAgentConversation(ctx.runtime, params.id), params)
  }),
  defineMethod({
    name: 'agent.close',
    permission: 'workspace',
    params: AgentCloseParams,
    handler: async (params, ctx): Promise<AgentCloseResult> =>
      closeAgentConversation(ctx, await resolveAgentConversation(ctx.runtime, params.id))
  })
]
