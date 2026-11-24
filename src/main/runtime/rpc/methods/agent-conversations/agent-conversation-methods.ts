import { defineMethod } from '../../core'
import {
  AgentListParams,
  AgentReadParams,
  AgentSendParams,
  AgentShowParams
} from '../../../../../shared/rpc-contract/agent-conversation-params'
import type {
  AgentListResult,
  AgentReadResult,
  AgentSendResult,
  AgentShowResult
} from '../../../../../shared/agent-conversations/agent-conversation-contracts'
import {
  agentConversationPlaces,
  projectAgentConversationList
} from '../../../agent-conversations/agent-conversation-list'
import { resolveAgentConversation } from '../../../agent-conversations/agent-conversation-address'
import { readAgentConversation } from '../../../agent-conversations/agent-conversation-read'
import { sendAgentConversation } from '../../../agent-conversations/agent-conversation-send'

// Listing reads every workspace's open agents, so no workspace page may hide one.
const AGENT_LIST_WORKTREE_LIMIT = 10_000

/** `orca agent list/show/read/send`: agents by their Orca session ID, chats and terminals alike.
 *  Only send writes: it gives a chat a message, as its composer does. The others never send to,
 *  start or wake an agent. */
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
    name: 'agent.send',
    permission: 'workspace',
    params: AgentSendParams,
    handler: async (params, ctx): Promise<AgentSendResult> =>
      sendAgentConversation(ctx, await resolveAgentConversation(ctx.runtime, params.id), params)
  })
]
