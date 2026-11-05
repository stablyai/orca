import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  attachClaudePermissionToolUseId,
  shouldKeepClaudePermissionVisible
} from './server-claude-status-rules'
import type { EnrichedAgentHookEventPayload } from './server-types'

/** A held permission keeps its row, so PreToolUse seen meanwhile is kept for the next PermissionRequest's tool_use_id. */
export class ClaudePermissionHold {
  private readonly heldPreToolUseByPaneKey = new Map<string, AgentHookEventPayload>()

  attachToolUseId(
    previous: EnrichedAgentHookEventPayload | undefined,
    next: AgentHookEventPayload
  ): AgentHookEventPayload {
    return attachClaudePermissionToolUseId(
      this.heldPreToolUseByPaneKey.get(next.paneKey) ?? previous,
      next
    )
  }

  keeps(
    previous: EnrichedAgentHookEventPayload | undefined,
    next: AgentHookEventPayload
  ): previous is EnrichedAgentHookEventPayload {
    if (!previous || !shouldKeepClaudePermissionVisible(previous, next)) {
      this.heldPreToolUseByPaneKey.delete(next.paneKey)
      return false
    }
    if (next.hookEventName === 'PreToolUse' && next.toolUseId) {
      this.heldPreToolUseByPaneKey.set(next.paneKey, next)
    }
    return true
  }
}
