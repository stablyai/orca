// Which agent a tool call, a frame or a prompt belongs to, answered from the journal's own linkage,
// so a child's record, its open operation and its prompt rows all name the agent its rows name.

import type { AgentJournalProducerLinkage } from '../../shared/agent-session-journal-types'
import { claudePromptAskingChild, type ClaudePendingPrompt } from './claude-prompt-registry'
import type { ClaudeToolUse } from './claude-structured-item-translation'
import type { ClaudeSubagentLinkageSource } from './claude-subagent-linkage'
import type { ClaudeToolOriginRegistry } from './claude-tool-origin-registry'

export type ClaudeChildToolQueries = {
  /** The agent (its canonical task id) whose own traffic made a tool call; null when the session's
   *  own agent made it, or it was never seen. The same answer a row that call produced carries. */
  childToolOwner: (toolUseId: string) => string | null
  /** The child a frame's `parent_tool_use_id` names, and its newest call still awaiting a result. */
  childActivity: (parentToolUseId: string) => { agentId: string; openTool: ClaudeToolUse | null }
  /** The linkage a prompt row carries: the subagent that raised it, or none for the session's own. */
  promptProducer: (
    prompt: Pick<ClaudePendingPrompt, 'agentId' | 'toolUseId'>
  ) => AgentJournalProducerLinkage
}

export function claudeChildToolQueries(deps: {
  tools: ReadonlyMap<string, ClaudeToolUse>
  toolOrigins: Pick<ClaudeToolOriginRegistry, 'childOwnerRef'>
  linkage: Pick<ClaudeSubagentLinkageSource, 'settledLinkageFor'>
}): ClaudeChildToolQueries {
  const childToolOwner = (toolUseId: string): string | null => {
    const ownerRef = deps.toolOrigins.childOwnerRef(toolUseId)
    return ownerRef === null
      ? null
      : (deps.linkage.settledLinkageFor(ownerRef).linkage.agentId ?? null)
  }
  return {
    childToolOwner,
    childActivity: (parentToolUseId) => {
      let openTool: ClaudeToolUse | null = null
      for (const tool of deps.tools.values()) {
        if (deps.toolOrigins.childOwnerRef(tool.id) === parentToolUseId) {
          openTool = tool
        }
      }
      const { agentId } = deps.linkage.settledLinkageFor(parentToolUseId).linkage
      return { agentId: agentId ?? parentToolUseId, openTool }
    },
    promptProducer: (prompt) => {
      const agentId = claudePromptAskingChild(prompt, childToolOwner)
      return agentId === null ? {} : { agentId, producerKind: 'agent' }
    }
  }
}
