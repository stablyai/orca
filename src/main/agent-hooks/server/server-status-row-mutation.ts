import type { AgentStatusObservationOrigin } from '../../../shared/agent-status/contracts/agent-status-observation'
import { resumedAcceptedTurn } from './pane-agent-turn-continuity'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { RelaySessionGenerations } from './server-relay-sessions'

import type { EnrichedAgentHookEventPayload } from './server-types'

import { ClaudeOwedNotificationExpiryTimers } from '../../../shared/agent-hook-listener/providers/claude/background-tasks/claude-owed-notification-expiry-timers'

import { AgentHookServerStatusApplication } from './server-status-application'

const MAX_REMEMBERED_SUBMISSIONS = 1_000

export abstract class AgentHookServerStatusRowMutation extends AgentHookServerStatusApplication {
  /** When the user last submitted a line in each pane; a resumed CLI's startup ends there. */
  protected readonly lastSubmittedAtByPaneKey = new Map<string, number>()

  /** Kept only while a resumed row's startup window is open; pane teardown forgets it. */
  notePaneInputSubmitted(paneKey: string): void {
    const resolved = this.resolvePaneKeyAlias(paneKey)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this server stores enriched accepted rows in the listener's base-typed cache.
    const row = this.state.lastStatusByPaneKey.get(resolved) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (row?.observation?.origin !== 'launch') {
      return
    }
    // Pane teardown forgets marks; the oldest go first if panes outrun that.
    this.lastSubmittedAtByPaneKey.delete(resolved)
    this.lastSubmittedAtByPaneKey.set(resolved, Date.now())
    if (this.lastSubmittedAtByPaneKey.size > MAX_REMEMBERED_SUBMISSIONS) {
      const oldest = this.lastSubmittedAtByPaneKey.keys().next().value
      if (oldest !== undefined) {
        this.lastSubmittedAtByPaneKey.delete(oldest)
      }
    }
  }

  protected preserveAcceptedTurn(
    previous: EnrichedAgentHookEventPayload | undefined,
    incoming: AgentHookEventPayload,
    before: EnrichedAgentHookEventPayload | undefined,
    origin: AgentStatusObservationOrigin
  ): EnrichedAgentHookEventPayload | null | undefined {
    const submittedAt = previous && this.lastSubmittedAtByPaneKey.get(previous.paneKey)
    const startupOpen =
      submittedAt === undefined || submittedAt < (previous?.observation?.observedAt ?? 0)
    const resumed = previous && resumedAcceptedTurn(previous, incoming, origin, startupOpen)
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
