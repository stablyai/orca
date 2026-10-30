import type { AgentJournalProducerLinkage } from '../../shared/agent-session-journal-types'
import type { ClaudePendingPrompt } from './claude-prompt-registry'
import type { ClaudeToolUse } from './claude-structured-item-translation'
import type {
  ClaudeAgentLinkageSource,
  ClaudeSubagentLinkageSource
} from './claude-subagent-linkage'
import type { ClaudeToolOriginRegistry } from './claude-tool-origin-registry'

export type ClaudeChildToolQueries = {
  /** Canonical journal owner; null for the session agent or unseen calls. */
  childToolOwner: (toolUseId: string) => string | null
  /** The child named by `parent_tool_use_id` and its newest unanswered call. */
  childActivity: (parentToolUseId: string) => { agentId: string; openTool: ClaudeToolUse | null }
  /** Use the asking agent's journal linkage; empty for the session agent. */
  promptProducer: (
    prompt: Pick<ClaudePendingPrompt, 'agentId' | 'toolUseId'>
  ) => AgentJournalProducerLinkage
}

export function claudeChildToolQueries(deps: {
  tools: ReadonlyMap<string, ClaudeToolUse>
  toolOrigins: Pick<ClaudeToolOriginRegistry, 'childOwnerRef'>
  linkage: Pick<ClaudeSubagentLinkageSource, 'settledLinkageFor'> & ClaudeAgentLinkageSource
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
      if (prompt.agentId !== undefined) {
        return deps.linkage.linkageForAgent(prompt.agentId)
      }
      const ownerRef = deps.toolOrigins.childOwnerRef(prompt.toolUseId)
      return ownerRef === null ? {} : deps.linkage.settledLinkageFor(ownerRef).linkage
    }
  }
}
