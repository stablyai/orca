import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  attachClaudePermissionToolUseId,
  shouldInheritClaudeToolUseIdForPermission,
  shouldKeepClaudePermissionVisible
} from './server-claude-status-rules'
import type { EnrichedAgentHookEventPayload } from './server-types'

/** A held permission keeps its row, so PreToolUse seen meanwhile is kept for the next PermissionRequest's tool_use_id. */
export class ClaudePermissionHold {
  private readonly heldPreToolUsesByPaneKey = new Map<string, AgentHookEventPayload[]>()

  attachToolUseId(
    previous: EnrichedAgentHookEventPayload | undefined,
    next: AgentHookEventPayload
  ): AgentHookEventPayload {
    const held = this.heldPreToolUsesByPaneKey.get(next.paneKey) ?? []
    // Unrelated tools may start between the retry's PreToolUse and its PermissionRequest.
    const source = held.findLast((candidate) =>
      shouldInheritClaudeToolUseIdForPermission(candidate, next)
    )
    return attachClaudePermissionToolUseId(source ?? previous, next)
  }

  keeps(
    previous: EnrichedAgentHookEventPayload | undefined,
    next: AgentHookEventPayload
  ): previous is EnrichedAgentHookEventPayload {
    if (!previous || !shouldKeepClaudePermissionVisible(previous, next)) {
      this.forget(next.paneKey)
      return false
    }
    if (!next.toolUseId) {
      return true
    }
    const held = (this.heldPreToolUsesByPaneKey.get(next.paneKey) ?? []).filter(
      (candidate) => candidate.toolUseId !== next.toolUseId
    )
    if (next.hookEventName === 'PreToolUse') {
      held.push(next)
    }
    if (held.length > 0) {
      this.heldPreToolUsesByPaneKey.set(next.paneKey, held)
    } else {
      this.heldPreToolUsesByPaneKey.delete(next.paneKey)
    }
    return true
  }

  forgetVacatedPane(
    before: EnrichedAgentHookEventPayload | null | undefined,
    after: EnrichedAgentHookEventPayload | null | undefined
  ): void {
    if (before && before.paneKey !== after?.paneKey) {
      this.forget(before.paneKey)
    }
  }

  private forget(paneKey: string): void {
    this.heldPreToolUsesByPaneKey.delete(paneKey)
  }
}
