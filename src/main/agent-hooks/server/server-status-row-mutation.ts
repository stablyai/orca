import { resumedAcceptedTurn } from './pane-agent-turn-continuity'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { RelaySessionGenerations } from './server-relay-sessions'

import type { EnrichedAgentHookEventPayload } from './server-types'

import { ClaudeOwedNotificationExpiryTimers } from '../../../shared/agent-hook-listener/providers/claude/background-tasks/claude-owed-notification-expiry-timers'

import { AgentHookServerStatusApplication } from './server-status-application'

export abstract class AgentHookServerStatusRowMutation extends AgentHookServerStatusApplication {
  protected preserveResumedAcceptedTurn(
    previous: EnrichedAgentHookEventPayload | undefined,
    incoming: AgentHookEventPayload,
    before: EnrichedAgentHookEventPayload | undefined
  ): EnrichedAgentHookEventPayload | null | undefined {
    const resumed = previous && resumedAcceptedTurn(previous, incoming)
    if (!resumed) {
      return null
    }
    if (!this.writeLegacyStatusRow(resumed)) {
      return undefined
    }
    this.runtimeObservedStatusPaneKeys.add(resumed.paneKey)
    this.commitStatusRowMutation(before, resumed)
    this.scheduleStatusPersist()
    return resumed
  }

  protected readonly claudeOwedNotificationExpiry = new ClaudeOwedNotificationExpiryTimers(
    this.state
  )

  protected readonly relaySessions = new RelaySessionGenerations()

  // Every row mutation passes here, including cancellation and pane moves.
  protected override commitStatusRowMutation(
    before: EnrichedAgentHookEventPayload | null | undefined,
    after: EnrichedAgentHookEventPayload | null | undefined,
    emit = true
  ): boolean {
    if (after) {
      this.claudeOwedNotificationExpiry.arm(after.paneKey, (row) => {
        if (this.server) {
          this.applyRestatedStatus(row)
        }
      })
    }
    return super.commitStatusRowMutation(before, after, emit)
  }
}
