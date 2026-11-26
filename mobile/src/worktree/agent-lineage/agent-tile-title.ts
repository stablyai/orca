import type { RuntimeWorktreeAgentRow } from '../../../../src/shared/worktree/catalog/runtime-worktree-contracts'
import { getAgentRowPrimaryText } from '../../../../src/shared/agent-status/presentation/agent-row-primary-text'
import { agentDisplayLabel } from './agent-row-display'

/** The short name a tile shows: the conversation's name, else the task the agent was given. */
export function agentTileTitle(agent: RuntimeWorktreeAgentRow, now: number): string {
  return (
    agent.conversationName?.trim() ||
    getAgentRowPrimaryText({ prompt: agent.prompt }) ||
    agentDisplayLabel(agent, now)
  )
}
