import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  attachClaudePermissionToolUseId,
  shouldInheritClaudeToolUseIdForPermission
} from './server-claude-status-rules'
import type { EnrichedAgentHookEventPayload } from './server-types'

const MAX_PENDING_PER_PANE = 32
const MAX_TRACKED_PANES = 64
const SESSION_BOUNDARY_EVENTS = new Set(['SessionStart', 'SessionEnd'])
const MAIN_TURN_BOUNDARY_EVENTS = new Set(['UserPromptSubmit', 'Stop', 'StopFailure'])

/** PermissionRequest omits tool_use_id; any unfinished PreToolUse in the pane may own it, not just the latest row. */
export class ClaudePendingToolUses {
  private readonly pendingByPaneKey = new Map<string, AgentHookEventPayload[]>()

  /** Attaches the inherited tool_use_id, then records the event unless it is a restated row. */
  admit(
    previous: EnrichedAgentHookEventPayload | undefined,
    next: AgentHookEventPayload,
    record: boolean
  ): AgentHookEventPayload {
    const matches = (this.pendingByPaneKey.get(next.paneKey) ?? []).filter((candidate) =>
      shouldInheritClaudeToolUseIdForPermission(candidate, next)
    )
    // Identical previews can't tell parallel tools apart, so keep the row-based guess.
    const attached =
      matches.length === 1
        ? { ...next, toolUseId: matches[0].toolUseId }
        : attachClaudePermissionToolUseId(previous, next)
    if (record) {
      this.record(attached)
    }
    return attached
  }

  forget(...paneKeys: string[]): void {
    for (const paneKey of paneKeys) {
      this.pendingByPaneKey.delete(paneKey)
    }
  }

  clear(): void {
    this.pendingByPaneKey.clear()
  }

  private record(event: AgentHookEventPayload): void {
    if (event.payload.agentType !== 'claude' || !event.hookEventName) {
      return
    }
    const current = this.pendingByPaneKey.get(event.paneKey) ?? []
    let pending: AgentHookEventPayload[]
    if (SESSION_BOUNDARY_EVENTS.has(event.hookEventName)) {
      pending = []
    } else if (MAIN_TURN_BOUNDARY_EVENTS.has(event.hookEventName)) {
      // Background subagents keep running past the main agent's turn.
      pending = current.filter((candidate) => candidate.toolAgentId)
    } else if (event.toolUseId) {
      pending = current.filter((candidate) => candidate.toolUseId !== event.toolUseId)
      // Tools denied before running never send PostToolUse, so bound what they leave behind.
      if (event.hookEventName === 'PreToolUse' && event.payload.state === 'working') {
        pending.push(event)
        pending.splice(0, pending.length - MAX_PENDING_PER_PANE)
      }
    } else {
      return
    }
    // Re-insert so the oldest pane is evicted first.
    this.pendingByPaneKey.delete(event.paneKey)
    if (pending.length > 0) {
      this.pendingByPaneKey.set(event.paneKey, pending)
    }
    for (const paneKey of this.pendingByPaneKey.keys()) {
      if (this.pendingByPaneKey.size <= MAX_TRACKED_PANES) {
        break
      }
      this.pendingByPaneKey.delete(paneKey)
    }
  }
}
