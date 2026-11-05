import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  attachClaudePermissionToolUseId,
  shouldInheritClaudeToolUseIdForPermission
} from './server-claude-status-rules'
import type { EnrichedAgentHookEventPayload } from './server-types'

const MAX_PENDING_PER_PANE = 32
const MAX_TRACKED_PANES = 64
const TURN_BOUNDARY_EVENTS = new Set([
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'SessionStart',
  'SessionEnd'
])

/** PermissionRequest omits tool_use_id; any unfinished PreToolUse in the pane may own it, not just the latest row. */
export class ClaudePendingToolUses {
  private readonly pendingByPaneKey = new Map<string, AgentHookEventPayload[]>()

  attach(
    previous: EnrichedAgentHookEventPayload | undefined,
    next: AgentHookEventPayload
  ): AgentHookEventPayload {
    const source = this.pendingByPaneKey
      .get(next.paneKey)
      ?.findLast((candidate) => shouldInheritClaudeToolUseIdForPermission(candidate, next))
    return source
      ? { ...next, toolUseId: source.toolUseId }
      : attachClaudePermissionToolUseId(previous, next)
  }

  observe<T extends AgentHookEventPayload>(event: T): T {
    if (event.payload.agentType !== 'claude') {
      return event
    }
    if (event.hookEventName && TURN_BOUNDARY_EVENTS.has(event.hookEventName)) {
      this.pendingByPaneKey.delete(event.paneKey)
      return event
    }
    if (!event.toolUseId) {
      return event
    }
    const pending = (this.pendingByPaneKey.get(event.paneKey) ?? []).filter(
      (candidate) => candidate.toolUseId !== event.toolUseId
    )
    // Tools denied before running never send PostToolUse, so bound what they leave behind.
    if (event.hookEventName === 'PreToolUse' && event.payload.state === 'working') {
      pending.push(event)
      pending.splice(0, pending.length - MAX_PENDING_PER_PANE)
    }
    // Re-insert so the oldest pane is evicted first; closed panes need no explicit cleanup.
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
    return event
  }

  clear(): void {
    this.pendingByPaneKey.clear()
  }
}
