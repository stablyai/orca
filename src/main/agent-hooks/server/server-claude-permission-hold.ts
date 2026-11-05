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
      // Another request replacing the row must not drop the candidates still waiting for theirs.
      if (next.hookEventName === 'PermissionRequest' && next.toolUseId) {
        this.replaceCandidate(next.paneKey, next.toolUseId)
      } else {
        this.forget(next.paneKey)
      }
      return false
    }
    if (next.toolUseId) {
      this.replaceCandidate(
        next.paneKey,
        next.toolUseId,
        next.hookEventName === 'PreToolUse' ? next : undefined
      )
    }
    return true
  }

  private replaceCandidate(
    paneKey: string,
    toolUseId: string,
    replacement?: AgentHookEventPayload
  ): void {
    const held = (this.heldPreToolUsesByPaneKey.get(paneKey) ?? []).filter(
      (candidate) => candidate.toolUseId !== toolUseId
    )
    if (replacement) {
      held.push(replacement)
    }
    if (held.length > 0) {
      this.heldPreToolUsesByPaneKey.set(paneKey, held)
    } else {
      this.heldPreToolUsesByPaneKey.delete(paneKey)
    }
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
