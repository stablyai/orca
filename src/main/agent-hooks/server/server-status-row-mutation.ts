import type { AgentStatusObservationOrigin } from '../../../shared/agent-status/contracts/agent-status-observation'
import { resumedAcceptedTurn } from './pane-agent-turn-continuity'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { RelaySessionGenerations } from './server-relay-sessions'

import type { EnrichedAgentHookEventPayload } from './server-types'

import { HookLeaseExpiryTimers } from '../../../shared/agent-hook-listener/leases/hook-lease-expiry-timers'

import { AgentHookServerStatusApplication } from './server-status-application'

export abstract class AgentHookServerStatusRowMutation extends AgentHookServerStatusApplication {
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

  protected readonly leaseExpiry = new HookLeaseExpiryTimers(this.state)

  protected readonly relaySessions = new RelaySessionGenerations()

  // Every row mutation passes here, including cancellation and pane moves.
  protected override commitStatusRowMutation(
    before: EnrichedAgentHookEventPayload | null | undefined,
    after: EnrichedAgentHookEventPayload | null | undefined,
    emit = true
  ): boolean {
    if (after) {
      this.leaseExpiry.arm(after.paneKey, (row) => {
        if (this.server) {
          this.applyRestatedStatus(row)
        }
      })
    }
    return super.commitStatusRowMutation(before, after, emit)
  }
}
