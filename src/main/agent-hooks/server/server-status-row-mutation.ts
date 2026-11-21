import type { AgentStatusObservationOrigin } from '../../../shared/agent-status/contracts/agent-status-observation'
import { resumedAcceptedTurn } from './pane-agent-turn-continuity'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { RelaySessionGenerations } from './server-relay-sessions'

import type { EnrichedAgentHookEventPayload } from './server-types'

import { ClaudeOwedNotificationExpiryTimers } from '../../../shared/agent-hook-listener/providers/claude/background-tasks/claude-owed-notification-expiry-timers'

import { AgentHookServerStatusApplication } from './server-status-application'

export abstract class AgentHookServerStatusRowMutation extends AgentHookServerStatusApplication {
  protected applyAntigravityModel(
    original: EnrichedAgentHookEventPayload,
    model: string
  ): EnrichedAgentHookEventPayload | undefined {
    if (original.paneSleep || this.state.lastStatusByPaneKey.get(original.paneKey) !== original) {
      return undefined
    }
    if (original.payload.model === model) {
      return original
    }
    const next = { ...original, payload: { ...original.payload, model } }
    if (!this.writeLegacyStatusRow(next)) {
      return undefined
    }
    this.commitStatusRowMutation(original, next)
    this.scheduleStatusPersist()
    this.publishAgentStatusMetadata(next)
    return next
  }

  protected preserveAcceptedTurn(
    previous: EnrichedAgentHookEventPayload | undefined,
    incoming: AgentHookEventPayload,
    before: EnrichedAgentHookEventPayload | undefined,
    origin: AgentStatusObservationOrigin
  ): EnrichedAgentHookEventPayload | null | undefined {
    const resumed = previous && resumedAcceptedTurn(previous, incoming, origin)
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
